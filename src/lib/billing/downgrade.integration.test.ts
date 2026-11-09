import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSegmentFilter } from '@/lib/audience/segments';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { addonPacks, cancelAddon, listAddons, purchaseAddon, reconcilePendingAddons } from './addons';
import { downgradeOverview, enforcePlanLimits, saveDowngradeSelection } from './downgrade';
import { getEntitlements, PlanLimitError } from './entitlements';
import { recordAiMessage, requireAiMessageRoom, requireStorageRoom } from './limits';
import type { BillingProvider, ProviderResult } from './provider';
import { currentUsage, monthlyActiveContacts } from './usage';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
// Add-on packs are charged with GST added, which needs the seller's state.
process.env.BILLING_SELLER_STATE_CODE = '29';

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const small = `small_${randomUUID().slice(0, 8)}`, big = `big_${randomUUID().slice(0, 8)}`;
const as = (accountId: string, userId: string, role: TenantContext['role']): TenantContext => ({ accountId, userId, role });
const admin = as(accountA, adminA, 'admin'), agent = as(accountA, agentA, 'agent'), otherOwner = as(accountB, ownerB, 'owner');
let owner: pg.Client;

// Created oldest first; "used" order (updated_at / last_executed_at) is set explicitly.
const seg = [randomUUID(), randomUUID(), randomUUID()];
const list = [randomUUID(), randomUUID()];
const flow = [randomUUID(), randomUUID(), randomUUID()];
const auto = [randomUUID(), randomUUID()];

function fakeProvider(outcome: 'ok' | 'rejected' | 'unknown', found: ProviderResult<{ id: string } | null> = { outcome: 'unknown' }):
  BillingProvider & { calls: number; references: string[]; finds: string[] } {
  const p = {
    name: 'razorpay' as const,
    calls: 0,
    references: [] as string[],
    finds: [] as string[],
    async findAddon(args: { reference: string }): Promise<ProviderResult<{ id: string } | null>> {
      p.finds.push(args.reference);
      return found;
    },
    async createAddon(args: { reference: string }): Promise<ProviderResult<{ id: string }>> {
      p.calls += 1;
      p.references.push(args.reference);
      if (outcome === 'ok') return { outcome: 'ok', value: { id: `ao_${randomUUID().slice(0, 12)}` } };
      if (outcome === 'rejected') return { outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 };
      return { outcome: 'unknown' };
    },
  };
  return p as unknown as BillingProvider & { calls: number; references: string[]; finds: string[] };
}

const setPlan = (planId: string, extra = '') =>
  owner.query(`INSERT INTO account_subscriptions(account_id, plan_id, status${extra ? ', scheduled_plan, current_period_end' : ''})
    VALUES($1, $2, 'active'${extra ? ", $3, now() + interval '10 days'" : ''})
    ON CONFLICT (account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, status='active', scheduled_plan=${extra ? 'EXCLUDED.scheduled_plan' : 'NULL'},
      cancel_at_period_end=false`, extra ? [accountA, planId, extra] : [accountA, planId]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('usage limits, add-ons and downgrade on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Usage test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Usage A',$2),($3,'Usage B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, adminA, agentA, accountB, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES
      ($1,'Small','{}','{"segments":1,"lists":1,"active_flows":1,"active_automations":1,"ai_messages":2,"storage_bytes":1000,"seats":5}'),
      ($2,'Big','{}','{"segments":10,"lists":10,"active_flows":10,"active_automations":10,"ai_messages":100,"storage_bytes":100000,"seats":5}')`, [small, big]);
    const days = (n: number) => `now() - interval '${n} days'`;
    for (const [i, id] of seg.entries())
      await owner.query(`INSERT INTO segments(id,account_id,user_id,name,filter,created_at,updated_at) VALUES($1,$2,$3,$4,'{"conditions":[{"field":"opted_out","op":"is","value":false}]}',${days(30)},${days(10 - i * 3)})`, [id, accountA, adminA, `Seg ${i}`]);
    for (const [i, id] of list.entries())
      await owner.query(`INSERT INTO contact_lists(id,account_id,user_id,name,created_at,updated_at) VALUES($1,$2,$3,$4,${days(30)},${days(10 - i * 3)})`, [id, accountA, adminA, `List ${i}`]);
    // flow 0 active (used long ago), flow 1 active (used recently), flow 2 a draft with a test number (used mid).
    await owner.query(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,test_numbers,last_executed_at) VALUES
      ($1,$4,$5,'Flow 0','active','manual','{}',${days(9)}),($2,$4,$5,'Flow 1','active','manual','{}',${days(1)}),
      ($3,$4,$5,'Flow 2','draft','manual','{919999999999}',${days(5)})`, [...flow, accountA, adminA]);
    await owner.query(`INSERT INTO automations(id,account_id,user_id,name,trigger_type,is_active,last_executed_at) VALUES
      ($1,$3,$4,'Auto 0','manual',true,${days(1)}),($2,$3,$4,'Auto 1','manual',true,${days(8)})`, [...auto, accountA, adminA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.query('DELETE FROM plans WHERE id = ANY($1::text[])', [[small, big]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores an admin choice for a scheduled downgrade without archiving anything yet', async () => {
    await setPlan(big, small);
    const view = await withTenant(admin, (tx) => downgradeOverview(tx, accountA));
    expect(view).toMatchObject({ plan: { id: small, name: 'Small' }, pending: true, selection: null });
    expect(view.effectiveAt).not.toBeNull();
    const byKind = Object.fromEntries(view.kinds.map((k) => [k.kind, k]));
    expect(byKind.segments.excess).toBe(2);
    expect(byKind.flows.items.map((i) => i.id)).toEqual([flow[1], flow[2], flow[0]]);
    expect(byKind.automations.items.map((i) => i.id)).toEqual([auto[0], auto[1]]);

    await expect(withTenant(admin, (tx) => saveDowngradeSelection(tx, accountA, adminA, small, { segments: [seg[0], seg[1]] })))
      .rejects.toMatchObject({ code: 'too_many' });
    await expect(withTenant(admin, (tx) => saveDowngradeSelection(tx, accountA, adminA, big, {})))
      .rejects.toMatchObject({ code: 'stale_plan' });
    await expect(withTenant(admin, (tx) => saveDowngradeSelection(tx, accountA, adminA, small, { segments: [randomUUID()] })))
      .rejects.toMatchObject({ code: 'invalid_selection' });
    const saved = await withTenant(admin, (tx) => saveDowngradeSelection(tx, accountA, adminA, small,
      { segments: [seg[0]], flows: [flow[0]], automations: [auto[1]] }));
    expect(saved).toEqual({ applied: false });
    expect((await withTenant(admin, (tx) => downgradeOverview(tx, accountA))).selection).toEqual({ segments: [seg[0]], flows: [flow[0]], automations: [auto[1]] });
    const { rows } = await owner.query('SELECT count(*)::int AS n FROM segments WHERE account_id=$1 AND archived_at IS NOT NULL', [accountA]);
    expect(rows[0].n).toBe(0);
  });

  it('keeps choices from agents and other workspaces', async () => {
    await expect(withTenant(agent, (tx) => tx.$queryRaw`SELECT * FROM downgrade_selections`)).resolves.toEqual([]);
    await expect(withTenant(agent, (tx) => tx.$executeRaw`INSERT INTO downgrade_selections(plan_id) VALUES(${small})`)).rejects.toThrow();
    await expect(withTenant(otherOwner, (tx) => tx.$queryRaw`SELECT * FROM downgrade_selections`)).resolves.toEqual([]);
  });

  it('archives what does not fit when the plan takes effect, keeping the choice and deleting nothing', async () => {
    await setPlan(small);
    const result = await enforcePlanLimits(accountA);
    expect(result).toEqual({
      segments: { archived: 2, restored: 0 }, lists: { archived: 1, restored: 0 },
      flows: { archived: 2, restored: 0 }, automations: { archived: 1, restored: 0 },
    });
    const segs = await owner.query('SELECT id, archived_at IS NOT NULL AS archived FROM segments WHERE account_id=$1 ORDER BY name', [accountA]);
    expect(segs.rows).toEqual([{ id: seg[0], archived: false }, { id: seg[1], archived: true }, { id: seg[2], archived: true }]);
    // No choice for lists: the most recently used stays.
    const lists = await owner.query('SELECT id FROM contact_lists WHERE account_id=$1 AND archived_at IS NULL', [accountA]);
    expect(lists.rows).toEqual([{ id: list[1] }]);
    const flows = await owner.query('SELECT id, status, archived_at IS NOT NULL AS archived FROM flows WHERE account_id=$1 ORDER BY name', [accountA]);
    expect(flows.rows).toEqual([{ id: flow[0], status: 'active', archived: false }, { id: flow[1], status: 'archived', archived: true },
      { id: flow[2], status: 'archived', archived: true }]);
    const autos = await owner.query('SELECT id, is_active FROM automations WHERE account_id=$1 ORDER BY name', [accountA]);
    expect(autos.rows).toEqual([{ id: auto[0], is_active: false }, { id: auto[1], is_active: true }]);

    const usage = await withTenant(agent, (tx) => currentUsage(tx, accountA));
    expect(usage).toMatchObject({ segments: 1, lists: 1, active_flows: 1, active_automations: 1 });
    // Running again changes nothing.
    expect((await enforcePlanLimits(accountA)).segments).toEqual({ archived: 0, restored: 0 });
    const view = await withTenant(admin, (tx) => downgradeOverview(tx, accountA));
    expect(view.pending).toBe(false);
    expect(view.archived.map((a) => a.id).sort()).toEqual([seg[1], seg[2], list[0], flow[1], flow[2], auto[0]].sort());
    await expect(withTenant(agent, (tx) => tx.$queryRaw`SELECT * FROM plan_archives`)).resolves.toEqual([]);
  });

  it('refuses an archived segment for a new campaign but still lets it be read', async () => {
    await expect(withTenant(admin, (tx) => loadSegmentFilter(tx, accountA, seg[1], { lock: true }))).rejects.toThrow(/archived/);
    await expect(withTenant(admin, (tx) => loadSegmentFilter(tx, accountA, seg[1]))).resolves.toMatchObject({ conditions: [{ field: 'opted_out' }] });
  });

  it('restores archived items to their prior state when the limits allow again', async () => {
    await setPlan(big);
    const result = await enforcePlanLimits(accountA);
    expect(result).toEqual({
      segments: { archived: 0, restored: 2 }, lists: { archived: 0, restored: 1 },
      flows: { archived: 0, restored: 2 }, automations: { archived: 0, restored: 1 },
    });
    const flows = await owner.query('SELECT id, status, archived_at FROM flows WHERE account_id=$1 ORDER BY name', [accountA]);
    expect(flows.rows.map((r) => [r.id, r.status, r.archived_at])).toEqual([[flow[0], 'active', null], [flow[1], 'active', null], [flow[2], 'draft', null]]);
    const autos = await owner.query('SELECT bool_and(is_active) AS on, bool_and(archived_at IS NULL) AS clear FROM automations WHERE account_id=$1', [accountA]);
    expect(autos.rows[0]).toEqual({ on: true, clear: true });
    expect((await withTenant(admin, (tx) => downgradeOverview(tx, accountA))).archived).toEqual([]);
  });

  it('applies a choice at once when the smaller plan is already in effect, by an admin', async () => {
    await setPlan(small);
    const saved = await withTenant(admin, (tx) => saveDowngradeSelection(tx, accountA, adminA, small, { segments: [seg[2]] }));
    expect(saved).toEqual({ applied: true });
    const kept = await owner.query('SELECT id FROM segments WHERE account_id=$1 AND archived_at IS NULL', [accountA]);
    expect(kept.rows).toEqual([{ id: seg[2] }]);
    // Re-activating an archived automation (the activation route checks the plan) clears its archive mark.
    await owner.query('UPDATE automations SET is_active=false WHERE id=$1', [auto[1]]);
    const archivedAuto = (await owner.query('SELECT id FROM automations WHERE account_id=$1 AND archived_at IS NOT NULL', [accountA])).rows[0].id;
    await owner.query('UPDATE automations SET is_active=true WHERE id=$1', [archivedAuto]);
    expect((await owner.query('SELECT archived_at FROM automations WHERE id=$1', [archivedAuto])).rows[0].archived_at).toBeNull();
  });

  it('counts AI messages per month and refuses generation over the plan', async () => {
    await setPlan(small);
    await requireAiMessageRoom(accountA);
    await recordAiMessage(accountA);
    await recordAiMessage(accountA, getWorkerPrisma());
    await expect(requireAiMessageRoom(accountA)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(requireAiMessageRoom(accountA, getWorkerPrisma())).rejects.toThrow(/AI replies this month/);
    // Another workspace (no subscription) is unaffected.
    await expect(requireAiMessageRoom(accountB)).resolves.toBeUndefined();
  });

  it('refuses member uploads that would exceed the plan storage', async () => {
    await owner.query("INSERT INTO media_objects(account_id,bucket,object_key,content_type,byte_size) VALUES($1,'chat-media','a/x.png','image/png',900)", [accountA]);
    await withTenant(agent, (tx) => requireStorageRoom(tx, accountA, 100));
    await expect(withTenant(agent, (tx) => requireStorageRoom(tx, accountA, 101))).rejects.toBeInstanceOf(PlanLimitError);
    await withTenant(agent, (tx) => requireStorageRoom(tx, accountA, -500));
  });

  it('caches monthly active contacts per period', async () => {
    expect(await withTenant(agent, (tx) => monthlyActiveContacts(tx, accountA))).toBe(0);
    await owner.query("UPDATE usage_counters SET value=7 WHERE account_id=$1 AND metric='monthly_active_contacts'", [accountA]);
    expect(await withTenant(agent, (tx) => monthlyActiveContacts(tx, accountA))).toBe(7);
    await owner.query("UPDATE usage_counters SET updated_at=now() - interval '1 hour' WHERE account_id=$1 AND metric='monthly_active_contacts'", [accountA]);
    expect(await withTenant(agent, (tx) => monthlyActiveContacts(tx, accountA))).toBe(0);
  });

  describe('add-ons', () => {
    const pack = addonPacks({ BILLING_ADDON_PRICES: JSON.stringify([{ kind: 'ai_messages', quantity: 50, amount_minor: 9900 }]) })[0];

    it('needs a billable subscription', async () => {
      const provider = fakeProvider('ok');
      await expect(purchaseAddon(provider, { accountId: accountA, userId: adminA, pack, packs: 1 })).rejects.toMatchObject({ code: 'needs_subscription' });
      expect(provider.calls).toBe(0);
      await owner.query("UPDATE account_subscriptions SET provider='razorpay', provider_subscription_id=$2, current_period_end=now() + interval '20 days' WHERE account_id=$1",
        [accountA, `sub_U${randomUUID().slice(0, 8)}`]);
    });

    it('grants an add-on only after the provider confirmed it', async () => {
      const before = (await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages;
      expect(await purchaseAddon(fakeProvider('rejected'), { accountId: accountA, userId: adminA, pack, packs: 1 })).toMatchObject({ status: 'failed' });
      expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages).toBe(before);
      // No billing profile: the place of supply is the seller's state, so 2 x (9900 + 9% CGST + 9% SGST) is charged and recorded.
      const ok = await purchaseAddon(fakeProvider('ok'), { accountId: accountA, userId: adminA, pack, packs: 2 });
      expect(ok.status).toBe('active');
      expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages).toBe((before ?? 0) + 100);
      await expect(requireAiMessageRoom(accountA)).resolves.toBeUndefined();
      // An unclear answer stays pending and grants nothing; the provider was given the row's own id (audit finding 53).
      const unclear = fakeProvider('unknown');
      const pending = await purchaseAddon(unclear, { accountId: accountA, userId: adminA, pack, packs: 2 });
      expect(pending).toMatchObject({ status: 'pending' });
      expect(unclear.references).toEqual([pending.id]);
      expect((await owner.query('SELECT provider_marker FROM add_ons WHERE id=$1', [pending.id])).rows[0]).toEqual({ provider_marker: true });
      expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages).toBe((before ?? 0) + 100);
      // While it is pending, the same pack cannot be bought again (a retry could be charged twice for one grant).
      const retry = fakeProvider('ok');
      await expect(purchaseAddon(retry, { accountId: accountA, userId: adminA, pack, packs: 2 })).rejects.toMatchObject({ code: 'purchase_pending', status: 409 });
      expect(retry.calls).toBe(0);

      const listed = await withTenant(admin, (tx) => listAddons(tx, accountA));
      expect(listed.map((a) => a.status).sort()).toEqual(['active', 'failed', 'pending']);
      expect(listed.find((a) => a.id === ok.id)).toMatchObject({ kind: 'ai_messages', quantity: 100, amountMinor: 23364, currency: 'INR' });
      expect(listed.find((a) => a.id === ok.id)?.endsAt).not.toBeNull();
      expect(JSON.stringify(listed)).not.toMatch(/ao_/);
      // Add-on rows are admin-only; members see only the raised limits.
      await expect(withTenant(agent, (tx) => listAddons(tx, accountA))).resolves.toEqual([]);
      await expect(withTenant(admin, (tx) => tx.$executeRaw`UPDATE add_ons SET status='active'`)).rejects.toThrow(/permission denied/);

      await expect(cancelAddon(accountA, adminA, listed.find((a) => a.status === 'pending')!.id)).rejects.toMatchObject({ code: 'not_cancellable' });
      await cancelAddon(accountA, adminA, ok.id);
      expect((await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages).toBe(before);
      await expect(cancelAddon(accountB, ownerB, ok.id)).rejects.toMatchObject({ code: 'not_cancellable' });
    });

    it('reconciles a pending add-on only from the provider\'s own add-on, fails one the provider never made, and hands the rest to an operator (audit finding 53)', async () => {
      const status = async (id: string) => (await owner.query('SELECT status, provider_addon_id FROM add_ons WHERE id=$1', [id])).rows[0];
      const limit = async () => (await withTenant(agent, (tx) => getEntitlements(tx, accountA))).limits.ai_messages;
      const soon = new Date(Date.now() + 3 * 60_000);
      const [{ id: pending }] = (await owner.query("SELECT id::text FROM add_ons WHERE account_id=$1 AND status='pending'", [accountA])).rows;
      const before = await limit();

      // Too early (the purchase may still be answering): the provider is not asked.
      const early = fakeProvider('ok', { outcome: 'ok', value: { id: 'ao_found1' } });
      await reconcilePendingAddons(accountA, early, new Date());
      expect(early.finds).toEqual([]);
      // The provider's answer is unclear: nothing changes.
      await reconcilePendingAddons(accountA, fakeProvider('ok'), soon);
      expect(await status(pending)).toEqual({ status: 'pending', provider_addon_id: null });
      // The provider has the add-on carrying our id: granted, with its id recorded.
      const found = fakeProvider('ok', { outcome: 'ok', value: { id: 'ao_found1' } });
      await reconcilePendingAddons(accountA, found, soon);
      expect(found.finds).toEqual([pending]);
      expect(await status(pending)).toEqual({ status: 'active', provider_addon_id: 'ao_found1' });
      expect(await limit()).toBe((before ?? 0) + 100);
      await cancelAddon(accountA, adminA, pending);

      // The provider has none: still pending within the hour, failed after it, never granted.
      const absent = (await purchaseAddon(fakeProvider('unknown'), { accountId: accountA, userId: adminA, pack, packs: 1 })).id;
      const none = fakeProvider('ok', { outcome: 'ok', value: null });
      await reconcilePendingAddons(accountA, none, soon);
      expect((await status(absent)).status).toBe('pending');
      await reconcilePendingAddons(accountA, none, new Date(Date.now() + 2 * 3_600_000));
      expect(await status(absent)).toEqual({ status: 'failed', provider_addon_id: null });
      expect(await limit()).toBe(before);

      // Still unclear a day later: one operator item, however often the sweep runs.
      const stuck = (await purchaseAddon(fakeProvider('unknown'), { accountId: accountA, userId: adminA, pack, packs: 1 })).id;
      await owner.query("UPDATE add_ons SET created_at=now() - interval '2 days' WHERE id=$1", [stuck]);
      await reconcilePendingAddons(accountA, fakeProvider('ok'), new Date());
      await reconcilePendingAddons(accountA, fakeProvider('ok'), new Date());
      const items = (await owner.query("SELECT account_id::text, kind, detail->>'reason' AS reason FROM billing_reconciliation_items WHERE source_ref=$1", [`addon:${stuck}`])).rows;
      expect(items).toEqual([{ account_id: accountA, kind: 'intent_unknown', reason: 'unconfirmed' }]);
      expect((await status(stuck)).status).toBe('pending');
      // The definer the sweep scheduler uses lists this workspace while a marked add-on is pending.
      const listed = (await owner.query('SELECT account_id::text FROM crm_accounts_with_pending_addons()')).rows.map((r) => r.account_id);
      expect(listed).toContain(accountA);
      await owner.query("UPDATE add_ons SET status='failed' WHERE id=$1", [stuck]);
      await owner.query('DELETE FROM billing_reconciliation_items WHERE source_ref=$1', [`addon:${stuck}`]);
    });
  });
});
