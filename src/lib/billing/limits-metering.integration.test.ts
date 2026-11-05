// Phase 14 limits and metering on a real PostgreSQL: the count gates are
// race-free (N concurrent creates against a limit of L -> exactly L succeed)
// for seats, active automations, the flow move-to-draft path, member and API
// contact creates and new integrations; inbound contacts are never refused;
// the AI usage ledger reserves, replays, releases and expires per source event,
// is isolated per workspace, and sends each usage notice once per period; a
// workspace without a subscription takes no lock. Isolated test database only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { buildQuery } from '@/lib/data/builder';
import { executeQuery } from '@/lib/repositories/crm';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { createScopedClient } from '@/lib/data/server';
import { activateWithLoopLock } from '@/lib/automations/activation-lock';
import { moveToDraft } from '@/lib/flows/versions';
import { createWooStore } from '@/lib/integrations/woocommerce/stores';
import { reserveAi, releaseAi, settleAi } from '@/lib/ai/budget';
import { PlanLimitError } from './entitlements';
import { requireSeatRoom } from './limits';
import { currentUsage } from './usage';
import { runUsageHousekeeping } from '@/lib/jobs/usage-housekeeping';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), ownerB = randomUUID();
const plan = `lim_${randomUUID().slice(0, 8)}`;
const admin: TenantContext = { accountId: A, userId: adminA, role: 'admin' };
const digits = () => String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
let owner: pg.Client;

const settled = (all: PromiseLike<unknown>[]) => Promise.allSettled(all);
const fulfilled = (r: PromiseSettledResult<unknown>[]) => r.filter((x) => x.status === 'fulfilled').length;
const refused = (r: PromiseSettledResult<unknown>[]) =>
  r.filter((x) => x.status === 'rejected' && (x.reason instanceof PlanLimitError || x.reason?.code === 'plan_limit')).length;
const count = async (sql: string, args: unknown[]) => (await owner.query(sql, args)).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Phase 14 limits and metering on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Limits test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, adminA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Limits A',$2),($3,'Limits B',$4)", [A, ownerA, B, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($4,$5,'owner')", [A, ownerA, adminA, B, ownerB]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'Limited','{}',$2)`, [plan, JSON.stringify({
      seats: 3, active_automations: 1, active_flows: 1, contacts: 5, integrations: 1, ai_messages: 2, ai_tokens_monthly: null,
    })]);
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,$2,'active')", [A, plan]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])", [[A, B]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, ownerB]]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('seats: four simultaneous invitations with one seat left -> exactly one is created', async () => {
    const invite = () => withTenant(admin, async (tx) => {
      await requireSeatRoom(tx, A);
      await tx.$executeRaw`INSERT INTO account_invitations(account_id, token_hash, role, created_by_user_id, expires_at)
        VALUES (${A}::uuid, ${randomUUID().replace(/-/g, '')}, 'agent', ${adminA}::uuid, now() + interval '7 days')`;
    });
    const results = await settled([invite(), invite(), invite(), invite()]);
    expect(fulfilled(results)).toBe(1);
    expect(refused(results)).toBe(3);
    expect(await count('SELECT count(*)::int AS n FROM account_invitations WHERE account_id=$1', [A])).toBe(1);
    // The refusal recorded the 100% notice once, with a billing notification for the owner and admin.
    expect(await count("SELECT count(*)::int AS n FROM usage_notices WHERE account_id=$1 AND limit_key='seats' AND threshold=100", [A])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND type='billing' AND dedupe_key LIKE 'billing:usage:seats:%'", [A])).toBe(2);
  });

  it('active automations: three simultaneous activations with a cap of one -> exactly one; an active one is never refused', async () => {
    const ids: string[] = [];
    for (const name of ['Cap A', 'Cap B', 'Cap C'])
      ids.push((await owner.query("INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active) VALUES($1,$2,$3,'new_contact','{}',false) RETURNING id",
        [A, adminA, name])).rows[0].id);
    const candidate = (name: string) => ({ name, trigger_type: 'new_contact', trigger_config: {}, steps: [] });
    const results = await settled(ids.map((id, i) => activateWithLoopLock(admin, A, id, candidate(`Cap ${i}`))));
    expect(fulfilled(results)).toBe(1);
    expect(refused(results)).toBe(2);
    const active = (await owner.query('SELECT id FROM automations WHERE id = ANY($1::uuid[]) AND is_active', [ids])).rows.map((r) => r.id);
    expect(active).toHaveLength(1);
    // Editing the active one re-runs the locked flip: it stays on even though the plan is full.
    await owner.query("UPDATE plans SET limits = limits || '{\"active_automations\":0}' WHERE id=$1", [plan]);
    await expect(activateWithLoopLock(admin, A, active[0], candidate('edited'))).resolves.toBeNull();
    expect(await count('SELECT count(*)::int AS n FROM automations WHERE id=$1 AND is_active', [active[0]])).toBe(1);
    await owner.query("UPDATE plans SET limits = limits || '{\"active_automations\":1}' WHERE id=$1", [plan]);
  });

  it('active flows: three simultaneous moves to a testing draft with a cap of one -> exactly one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await owner.query(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id,test_numbers)
        VALUES($1,$2,$3,$4,'paused','manual','{}','start',ARRAY['91987654321${i}'])`, [id, A, adminA, `Testing ${i}`]);
      await owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,'start','start',$3),($1,$2,'done','end','{}')",
        [A, id, JSON.stringify({ next_node_key: 'done' })]);
      ids.push(id);
    }
    const results = await settled(ids.map((flowId) => withTenant(admin, (tx) => moveToDraft(tx, { accountId: A, flowId, userId: adminA }))));
    expect(fulfilled(results)).toBe(1);
    expect(refused(results)).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM flows WHERE id = ANY($1::uuid[]) AND status='draft'", [ids])).toBe(1);
  });

  it('contacts: member creates are held to the limit under concurrency; inbound and existing numbers never are', async () => {
    const browserInsert = (phone: string) => buildQuery('contacts', (spec) => executeQuery(spec, admin, true))
      .insert({ account_id: A, user_id: adminA, phone, name: 'Member' }).select('id')
      .then(({ error }) => { if (error) throw Object.assign(new Error(error.message), { code: error.code }); });
    // Two rows already exist; a CSV chunk of three fills the limit of five, the next chunk is refused whole.
    for (let i = 0; i < 2; i++) await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4)', [A, adminA, `+9198${digits()}`, 'Seed']);
    const chunk = await buildQuery('contacts', (spec) => executeQuery(spec, admin, true))
      .insert([0, 1, 2, 3].map(() => ({ account_id: A, user_id: adminA, phone: `+9197${digits()}`, name: 'Csv' }))).select('id');
    expect(chunk.error).toMatchObject({ code: 'plan_limit' });
    const results = await settled(Array.from({ length: 6 }, () => browserInsert(`+9196${digits()}`)));
    expect(fulfilled(results)).toBe(3);
    expect(refused(results)).toBe(3);
    expect(await count('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [A])).toBe(5);

    // The public API: a new number is refused at the limit, an existing one is found.
    const api = createScopedClient({ accountId: A, role: 'owner' }, undefined, true);
    await expect(findOrCreateContact(api, A, adminA, { phone: `+1415${digits().slice(0, 7)}` }, { enforceLimit: true })).rejects.toBeInstanceOf(PlanLimitError);
    const existingPhone = (await owner.query('SELECT phone FROM contacts WHERE account_id=$1 LIMIT 1', [A])).rows[0].phone;
    await expect(findOrCreateContact(api, A, adminA, { phone: existingPhone }, { enforceLimit: true })).resolves.toMatchObject({ created: false });

    // Inbound (server/worker paths) is never refused: the workspace may exceed the limit.
    const inbound = await api.from('contacts').insert({ account_id: A, user_id: adminA, phone: `+9195${digits()}`, name: 'Customer' }).select('id').single();
    expect(inbound.error).toBeNull();
    expect((await withTenant(admin, (tx) => currentUsage(tx, A))).contacts).toBe(6);
  });

  it('integrations: three simultaneous new store connections with a slot of one -> exactly one', async () => {
    const results = await settled([1, 2, 3].map((i) => withTenant(admin, (tx) => createWooStore(tx, A, { storeUrl: `https://shop${i}-${digits()}.example.com` }))));
    expect(fulfilled(results)).toBe(1);
    expect(refused(results)).toBe(2);
    expect((await withTenant(admin, (tx) => currentUsage(tx, A))).integrations).toBe(1);
  });

  it('AI ledger: live reservations count, a settled source event replays without metering, release and expiry free the hold', async () => {
    const first = await reserveAi(A, 'inbound:wamid.one', { message: true, tokens: 10 });
    const second = await reserveAi(A, 'inbound:wamid.two', { message: true, tokens: 10 });
    await expect(reserveAi(A, 'inbound:wamid.three', { message: true, tokens: 10 })).rejects.toThrow(/AI replies this month/);
    await releaseAi(second);
    const third = await reserveAi(A, 'inbound:wamid.three', { message: true, tokens: 10 });
    await settleAi(first, { tokens: 120 });
    await settleAi(first, { tokens: 120 });
    // Replay of a settled inbound message: allowed (the provider may run again), metered once.
    const replay = await reserveAi(A, 'inbound:wamid.one', { message: true, tokens: 10 });
    await settleAi(replay, { tokens: 999 });
    const counters = async () => Object.fromEntries((await owner.query(
      "SELECT metric, value::int AS v FROM usage_counters WHERE account_id=$1 AND metric IN ('ai_messages','ai_tokens')", [A])).rows.map((r) => [r.metric, r.v]));
    expect(await counters()).toEqual({ ai_messages: 1, ai_tokens: 120 });
    // A reservation older than 15 minutes stops counting by itself.
    await expect(reserveAi(A, 'inbound:wamid.four', { message: true, tokens: 10 })).rejects.toBeInstanceOf(PlanLimitError);
    await owner.query("UPDATE usage_events SET reserved_at = now() - interval '16 minutes' WHERE account_id=$1 AND source_key='inbound:wamid.three'", [A]);
    const fourth = await reserveAi(A, 'inbound:wamid.four', { message: true, tokens: 10 });
    await settleAi(fourth, { tokens: 5 });
    expect(await counters()).toEqual({ ai_messages: 2, ai_tokens: 125 });
    // 2 of 2: the 80% and 100% notices exist once for this month, however often usage settles.
    await settleAi(third, { tokens: 1 });
    expect((await owner.query("SELECT threshold FROM usage_notices WHERE account_id=$1 AND limit_key='ai_messages' ORDER BY threshold", [A])).rows.map((r) => r.threshold))
      .toEqual([80, 100]);
    // One email: reaching 100% does not also send the 80% warning.
    expect(await count("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='billing.email' AND dedupe_key LIKE '%usage:ai_messages:%'", [A])).toBe(1);
  });

  it('AI ledger: one workspace can neither see nor settle another workspace\'s source event', async () => {
    // B (no subscription: unlimited) records on the fast path, with no reservation.
    const b = await reserveAi(B, 'inbound:wamid.one', { message: true, tokens: 10 });
    expect(b.held).toEqual({ ai_messages: false, ai_tokens: false });
    await settleAi(b, { tokens: 7 });
    const rows = await withTenant({ accountId: B, role: 'owner' }, (tx) => tx.$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text FROM usage_events WHERE source_key='inbound:wamid.one'`, getWorkerPrisma());
    expect(rows.map((r) => r.account_id)).toEqual([B, B]);
    // Settling A's held key from B's scope changes nothing in A: the function only sees B's rows.
    await owner.query("UPDATE plans SET limits = limits || '{\"ai_messages\":10}' WHERE id=$1", [plan]);
    const held = await reserveAi(A, 'req:cross-tenant', { message: true, tokens: 1 });
    expect(held.held.ai_messages).toBe(true);
    const before = await count("SELECT value::int AS n FROM usage_counters WHERE account_id=$1 AND metric='ai_messages'", [A]);
    await settleAi({ ...held, accountId: B }, { tokens: 50 });
    expect((await owner.query("SELECT state FROM usage_events WHERE account_id=$1 AND metric='ai_messages' AND source_key='req:cross-tenant'", [A])).rows)
      .toEqual([{ state: 'reserved' }]);
    expect(await count("SELECT value::int AS n FROM usage_counters WHERE account_id=$1 AND metric='ai_messages'", [A])).toBe(before);
    expect(await count("SELECT count(*)::int AS n FROM usage_events WHERE account_id=$1 AND metric='ai_messages' AND source_key='req:cross-tenant'", [B])).toBe(0);
  });

  it('housekeeping removes only settled or released ledger rows older than 13 months, never held ones or counters', async () => {
    await owner.query(`INSERT INTO usage_events(account_id,metric,source_key,period,quantity,state,reserved_at,settled_at) VALUES
      ($1,'ai_tokens','old:settled','2025-01',5,'settled',now() - interval '14 months',now() - interval '14 months'),
      ($1,'ai_tokens','old:released','2025-01',5,'released',now() - interval '14 months',NULL),
      ($1,'ai_tokens','old:held','2025-01',5,'reserved',now() - interval '14 months',NULL),
      ($1,'ai_tokens','recent:settled',to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM'),5,'settled',now(),now())`, [A]);
    const counters = await count('SELECT count(*)::int AS n FROM usage_counters WHERE account_id=$1', [A]);
    expect(await runUsageHousekeeping(A)).toBe(2);
    const left = (await owner.query("SELECT source_key FROM usage_events WHERE account_id=$1 AND source_key LIKE 'old:%' OR (account_id=$1 AND source_key='recent:settled') ORDER BY 1", [A])).rows.map((r) => r.source_key);
    expect(left).toEqual(['old:held', 'recent:settled']);
    expect(await count('SELECT count(*)::int AS n FROM usage_counters WHERE account_id=$1', [A])).toBe(counters);
  });

  it('an unlimited workspace takes no advisory lock on the gates', async () => {
    const locks = await withTenant({ accountId: B, userId: ownerB, role: 'owner' }, async (tx) => {
      await requireSeatRoom(tx, B);
      return tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()`;
    });
    expect(locks[0].n).toBe(0);
  });
});
