// Phase 14 foundation on a real PostgreSQL: the migrations applied, every
// existing workspace resolves exactly as before, the per-role grants and RLS of
// the new tables, the platform role's function-only access, the append-only
// platform trail, plan publishing with pinning, the usage ledger's tenant
// isolation and replay safety, lifecycle and support-grant rules, and the
// initial-plan definer. Runs only against an isolated *test* database.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { getEntitlements, planTerms } from '@/lib/billing/entitlements';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
const platformUrl = process.env.TEST_PLATFORM_DATABASE_URL || configured?.PLATFORM_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID(), fresh = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), ownerB = randomUUID();
const plan = `p14_${randomUUID().slice(0, 8)}`;
const admin = 'ops@bodhinox.test';
let owner: pg.Client, app: pg.Client, worker: pg.Client, auth: pg.Client, platform: pg.Client;

/** Runs `sql` as `client` inside a transaction scoped to a workspace and role, then rolls back unless `commit`. */
async function scoped<T>(client: pg.Client, account: string, user: string, role: string, run: () => Promise<T>, commit = true): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.account_id',$1,true), set_config('app.user_id',$2,true), set_config('app.account_role',$3,true)",
      [account, user, role]);
    const result = await run();
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
const denied = expect.objectContaining({ code: '42501' });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !authUrl || !platformUrl)('Phase 14 foundation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    app = new pg.Client({ connectionString: appUrl });
    worker = new pg.Client({ connectionString: workerUrl });
    auth = new pg.Client({ connectionString: authUrl });
    platform = new pg.Client({ connectionString: platformUrl });
    for (const c of [owner, app, worker, auth, platform]) await c.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    expect((await platform.query('SELECT current_user AS u')).rows[0].u).toBe('bodhinox_platform');
    for (const [id, email] of [[ownerA, `${ownerA}@example.invalid`], [adminA, `${adminA}@example.invalid`], [ownerB, `${ownerB}@example.invalid`]])
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'P14','test-only-hash')", [id, email]);
    // Created two hours ago: "existing" workspaces from before the deploy.
    for (const [id, o, name] of [[accountA, ownerA, 'P14 A'], [accountB, ownerB, 'P14 B'], [accountC, ownerB, 'P14 C']])
      await owner.query("INSERT INTO accounts(id,name,owner_user_id,created_at) VALUES($1,$2,$3,now()-interval '2 hours')", [id, name, o]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($4,$5,'owner'),($6,$5,'owner')",
      [accountA, ownerA, adminA, accountB, ownerB, accountC]);
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'P14 test','{"appointments":true}','{"segments":2,"contacts":5}')`, [plan]);
    await owner.query('INSERT INTO plan_versions(plan_id,version,features,limits) SELECT id,1,features,limits FROM plans WHERE id=$1', [plan]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB, accountC, fresh]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB, accountC, fresh]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, ownerB]]);
      await owner.query('DELETE FROM plan_versions WHERE plan_id=$1', [plan]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      // platform_audit_log is append-only by design: its test rows stay (target ids no longer exist).
    }
    for (const c of [owner, app, worker, auth, platform]) await c?.end().catch(() => {});
    await disconnectDatabases();
  });

  it('applied every Phase 14 migration and backfilled version 1 of each plan from today\'s row', async () => {
    const applied = await owner.query("SELECT migration_name FROM _prisma_migrations WHERE migration_name LIKE '20261112%' AND finished_at IS NOT NULL ORDER BY 1");
    expect(applied.rows.map((r) => r.migration_name)).toEqual([
      '20261112100000_platform_role_audit', '20261112100100_plan_versions', '20261112100200_usage_ledger',
      '20261112100300_billing_reconciliation', '20261112100400_tenant_lifecycle_support', '20261112100500_workspace_privacy',
      '20261112100600_platform_validate']);
    const drift = await owner.query(`SELECT p.id FROM plans p JOIN plan_versions v ON v.plan_id=p.id AND v.version=1
      WHERE p.id IN ('free','basic','pro','enterprise') AND p.current_version=1 AND v.features=p.features AND v.limits=p.limits`);
    expect(drift.rows.map((r) => r.id).sort()).toEqual(['basic', 'enterprise', 'free', 'pro']);
    const fk = await owner.query("SELECT convalidated FROM pg_constraint WHERE conname='account_subscriptions_plan_version_fkey'");
    expect(fk.rows[0].convalidated).toBe(true);
    const role = await owner.query("SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname='bodhinox_platform'");
    expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolinherit: false });
  });

  it('resolves existing workspaces exactly as before: no row -> enterprise, live row when unpinned, free when not granting', async () => {
    const a: TenantContext = { accountId: accountA, userId: ownerA, role: 'owner' };
    const none = await withTenant(a, (tx) => getEntitlements(tx, accountA));
    expect(none.planId).toBe('enterprise');
    expect(Object.values(none.features).every(Boolean)).toBe(true);
    expect(Object.values(none.limits).every((v) => v === null)).toBe(true);

    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [accountA]);
    const live = await withTenant(a, (tx) => getEntitlements(tx, accountA));
    const basic = (await owner.query("SELECT limits FROM plans WHERE id='basic'")).rows[0].limits;
    expect(live).toMatchObject({ planId: 'basic', limits: { seats: basic.seats, segments: basic.segments, contacts: null, integrations: null } });

    await owner.query("UPDATE account_subscriptions SET status='cancelled' WHERE account_id=$1", [accountA]);
    expect((await withTenant(a, (tx) => getEntitlements(tx, accountA))).planId).toBe('free');
    await owner.query('DELETE FROM account_subscriptions WHERE account_id=$1', [accountA]);
  });

  it('holds a pinned subscription to its version after a publish; unpinned ones follow the live row', async () => {
    const v1 = (await owner.query('SELECT id FROM plan_versions WHERE plan_id=$1 AND version=1', [plan])).rows[0].id;
    await owner.query('INSERT INTO account_subscriptions(account_id,plan_id,plan_version_id) VALUES($1,$2,$3)', [accountB, plan, v1]);
    await owner.query('INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,$2)', [accountC, plan]);
    await owner.query("INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,'s1','{}'),($1,$2,'s2','{}')", [accountC, ownerB]);

    const draft = { features: { appointments: true }, limits: { segments: 1, contacts: 5 } };
    const preview = (await platform.query('SELECT crm_platform_plan_preview($1,$2::jsonb,$3::jsonb) AS p',
      [plan, JSON.stringify(draft.features), JSON.stringify(draft.limits)])).rows[0].p;
    // Only C resolves to the live row (B is pinned); C already has 2 segments > 1.
    expect(preview).toMatchObject({ current_version: 1, affected_workspaces: 1, tightened: [{ key: 'segments', current: 2, next: 1, over: 1 }] });

    await expect(platform.query('SELECT crm_platform_publish_plan_version($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
      [plan, JSON.stringify(draft.features), JSON.stringify({ segments: 3 }), 'note', admin, preview.preview_hash]))
      .rejects.toThrow(/preview_mismatch/);
    const published = await platform.query('SELECT crm_platform_publish_plan_version($1,$2::jsonb,$3::jsonb,$4,$5,$6) AS v',
      [plan, JSON.stringify(draft.features), JSON.stringify(draft.limits), 'Tighter segments', admin, preview.preview_hash]);
    expect(published.rows[0].v).toBe(2);
    // The same preview cannot publish twice (the version moved on).
    await expect(platform.query('SELECT crm_platform_publish_plan_version($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
      [plan, JSON.stringify(draft.features), JSON.stringify(draft.limits), 'again', admin, preview.preview_hash])).rejects.toThrow(/preview_mismatch/);

    const b = await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' }, (tx) => getEntitlements(tx, accountB));
    const c = await withTenant({ accountId: accountC, userId: ownerB, role: 'owner' }, (tx) => getEntitlements(tx, accountC));
    expect(b.limits.segments).toBe(2);
    expect(c.limits.segments).toBe(1);
    const terms = await withTenant({ accountId: accountB, role: 'owner' }, (tx) => planTerms(tx, plan, v1));
    expect(terms).toMatchObject({ version: 1, limits: { segments: 2 } });
    const audit = await owner.query("SELECT detail FROM platform_audit_log WHERE action='plan.publish' AND target_ref=$1", [`${plan}:v2`]);
    expect(audit.rows[0].detail).toMatchObject({ plan, version: 2, previous_version: 1 });

    // Moving subscribers is explicit and re-pins B to v2.
    // The version the admin saw is re-checked under the plan lock.
    await expect(platform.query('SELECT * FROM crm_platform_move_plan_subscribers($1,1,$2,$3)', [plan, admin, 'Apply version 2 to everyone']))
      .rejects.toThrow(/stale_version/);
    const moved = await platform.query('SELECT account_id, changed FROM crm_platform_move_plan_subscribers($1,2,$2,$3)', [plan, admin, 'Apply version 2 to everyone']);
    expect(moved.rows.map((r) => r.account_id).sort()).toEqual([accountB, accountC].sort());
    expect((await withTenant({ accountId: accountB, role: 'owner' }, (tx) => getEntitlements(tx, accountB))).limits.segments).toBe(1);
    // One audit row per moved workspace, in both trails.
    for (const acct of moved.rows.filter((r) => r.changed).map((r) => r.account_id)) {
      expect((await owner.query("SELECT 1 FROM platform_audit_log WHERE action='plan.subscriber_moved' AND target_account_id=$1", [acct])).rowCount).toBe(1);
      expect((await owner.query("SELECT 1 FROM audit_logs WHERE action='plan.subscriber_moved' AND account_id=$1", [acct])).rowCount).toBe(1);
    }
    // Repeating the move changes nothing but returns the same workspaces, so an interrupted archive step can finish.
    const again = await platform.query('SELECT account_id, changed FROM crm_platform_move_plan_subscribers($1,2,$2,$3)', [plan, admin, 'Apply version 2 to everyone']);
    expect(again.rows.map((r) => r.account_id).sort()).toEqual([accountB, accountC].sort());
    expect(again.rows.every((r) => r.changed === false)).toBe(true);
  });

  it('refuses invalid terms and any tightening of the enterprise fallback', async () => {
    const hash = (await platform.query("SELECT crm_platform_plan_preview('enterprise','{}'::jsonb,'{}'::jsonb) AS p")).rows[0].p.preview_hash;
    await expect(platform.query("SELECT crm_platform_publish_plan_version('enterprise','{}'::jsonb,'{}'::jsonb,'x',$1,$2)", [admin, hash]))
      .rejects.toThrow(/plan_locked/);
    await expect(platform.query(`SELECT crm_platform_plan_preview('enterprise','{}'::jsonb,'{"seats":5}'::jsonb)`)).resolves.toBeTruthy();
    await expect(platform.query(`SELECT crm_platform_publish_plan_version('enterprise','{}'::jsonb,'{"seats":5}'::jsonb,'x',$1,'h')`, [admin]))
      .rejects.toThrow(/plan_locked/);
    for (const limits of ['{"bogus":1}', '{"seats":-1}', '{"seats":1.5}', '{"seats":"3"}'])
      await expect(platform.query('SELECT crm_platform_plan_preview($1,$2::jsonb,$3::jsonb)', [plan, '{}', limits])).rejects.toThrow(/invalid_plan_terms/);
    await expect(platform.query(`SELECT crm_platform_plan_preview($1,'{"appointments":1}'::jsonb,'{}'::jsonb)`, [plan])).rejects.toThrow(/invalid_plan_terms/);
  });

  it('gives the platform role functions only: no table, and no runtime role reaches the platform trail', async () => {
    for (const table of ['accounts', 'plans', 'plan_versions', 'platform_audit_log', 'billing_reconciliation_items', 'contacts', 'auth_users', 'jobs'])
      await expect(platform.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toEqual(denied);
    for (const client of [app, worker, auth])
      await expect(client.query('SELECT 1 FROM platform_audit_log LIMIT 1')).rejects.toEqual(denied);
    await expect(app.query('SELECT 1 FROM billing_reconciliation_items LIMIT 1')).rejects.toEqual(denied);
    for (const client of [app, worker, auth])
      await expect(client.query('SELECT * FROM crm_platform_tenants(NULL,NULL,1)')).rejects.toEqual(denied);
    await expect(app.query("SELECT crm_platform_audit('x@y.z','test.action',NULL,NULL,NULL,'{}'::jsonb)")).rejects.toEqual(denied);
    await expect(app.query("SELECT billing_assign_initial_plan($1,'free')", [accountA])).rejects.toEqual(denied);
    const tenants = await platform.query('SELECT * FROM crm_platform_tenants($1,NULL,10)', [accountB]);
    expect(tenants.rows).toEqual([expect.objectContaining({ account_id: accountB, name: 'P14 B', plan_id: plan, lifecycle_status: 'active' })]);
    // Fixed columns only.
    expect(Object.keys(tenants.rows[0]).sort()).toEqual(['account_id', 'block_manual', 'created_at', 'lifecycle_status', 'member_count', 'name',
      'owner_email', 'plan_id', 'plan_version', 'purge_after', 'subscription_status', 'usage'].sort());
  });

  it('writes both audit trails in one call and keeps the platform trail append-only', async () => {
    const id = (await worker.query("SELECT crm_platform_audit($1,'billing.prices_updated',$2,'basic','test','{\"n\":1}'::jsonb) AS id", [admin, accountA])).rows[0].id;
    const tenant = await owner.query("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='billing.prices_updated'", [accountA]);
    expect(tenant.rows[0]).toEqual({ user_id: null, metadata: { platform_admin_email: admin, platform_audit_id: id } });
    await expect(owner.query('UPDATE platform_audit_log SET reason=$2 WHERE id=$1', [id, 'edited'])).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM platform_audit_log WHERE id=$1', [id])).rejects.toThrow(/append-only/);
    await expect(owner.query('TRUNCATE platform_audit_log')).rejects.toThrow(/append-only/);
  });

  it('meters usage once per source event, only in the transaction\'s own workspace', async () => {
    const reserve = (client: pg.Client, account: string, key: string, qty: number, limit: number | null) =>
      scoped(client, account, '', '', async () => (await client.query('SELECT billing_reserve_usage($1,$2,$3,$4) AS r', ['ai_messages', key, qty, limit])).rows[0].r);
    const settle = (account: string, key: string, actual: number) =>
      scoped(worker, account, '', '', async () => (await worker.query('SELECT billing_settle_usage($1,$2,$3) AS r', ['ai_messages', key, actual])).rows[0].r);
    expect(await reserve(worker, accountA, 'inbound:1', 1, 2)).toBe('reserved');
    expect(await reserve(worker, accountA, 'inbound:1', 1, 2)).toBe('reserved'); // same key, already held
    expect(await reserve(worker, accountA, 'inbound:2', 1, 2)).toBe('reserved');
    expect(await reserve(worker, accountA, 'inbound:3', 1, 2)).toBe('over_limit'); // 2 live reservations
    expect(await settle(accountA, 'inbound:1', 1)).toBe(true);
    expect(await settle(accountA, 'inbound:1', 1)).toBe(false); // settled once
    expect(await reserve(worker, accountA, 'inbound:1', 1, 2)).toBe('replay');
    const counter = await owner.query("SELECT value FROM usage_counters WHERE account_id=$1 AND metric='ai_messages'", [accountA]);
    expect(Number(counter.rows[0].value)).toBe(1);
    // Tenant B sees and settles nothing of A's.
    expect(await scoped(app, accountB, ownerB, 'owner', async () => (await app.query('SELECT count(*)::int AS n FROM usage_events')).rows[0].n)).toBe(0);
    expect(await settle(accountB, 'inbound:2', 1)).toBe(false);
    expect((await owner.query("SELECT state FROM usage_events WHERE account_id=$1 AND source_key='inbound:2'", [accountA])).rows[0].state).toBe('reserved');
    // Unlimited fast path: recorded once.
    const record = () => scoped(worker, accountB, '', '', async () => (await worker.query("SELECT billing_record_usage('ai_tokens','task:1',40) AS r")).rows[0].r);
    expect(await record()).toBe(true);
    expect(await record()).toBe(false);
    // Without a tenant scope nothing is metered.
    await expect(worker.query("SELECT billing_record_usage('ai_tokens','task:2',1)")).rejects.toThrow(/tenant scope required/);
  });

  it('lets owners request deletion but never clear an admin suspension; platform lifecycle writes both trails', async () => {
    await scoped(app, accountA, ownerA, 'owner', () => app.query(
      "INSERT INTO account_lifecycle(account_id,status,deletion_requested_at,deletion_requested_by,purge_after) VALUES($1,'closing',now(),$2,now()+interval '30 days')",
      [accountA, ownerA]));
    await expect(scoped(app, accountA, adminA, 'admin', () => app.query("UPDATE account_lifecycle SET status='active' WHERE account_id=$1", [accountA])))
      .resolves.toMatchObject({ rowCount: 0 });
    await scoped(app, accountA, ownerA, 'owner', () => app.query("UPDATE account_lifecycle SET status='active', purge_after=NULL, deletion_requested_at=NULL WHERE account_id=$1", [accountA]));
    // An owner cannot write block_manual or the suspension columns at all.
    await expect(scoped(app, accountA, ownerA, 'owner', () => app.query('UPDATE account_lifecycle SET block_manual=false WHERE account_id=$1', [accountA])))
      .rejects.toEqual(denied);

    await expect(platform.query("SELECT crm_platform_set_lifecycle($1,'admin_suspended',true,'short',$2)", [accountB, admin])).rejects.toThrow(/reason_required/);
    await platform.query("SELECT crm_platform_set_lifecycle($1,'admin_suspended',true,'Abuse report under review',$2)", [accountB, admin]);
    await expect(scoped(app, accountB, ownerB, 'owner', () => app.query("UPDATE account_lifecycle SET status='closing', deletion_requested_at=now(), purge_after=now() WHERE account_id=$1", [accountB])))
      .resolves.toMatchObject({ rowCount: 0 });
    const row = await scoped(worker, accountB, '', '', async () => (await worker.query('SELECT status, block_manual FROM account_lifecycle')).rows);
    expect(row).toEqual([{ status: 'admin_suspended', block_manual: true }]);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='lifecycle.admin_suspended'", [accountB])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND type='billing'", [accountB])).rows[0].n).toBe(1);
    await platform.query("SELECT crm_platform_set_lifecycle($1,'active',false,'Review finished, all clear',$2)", [accountB, admin]);
  });

  it('shows diagnostics only through an approved, unexpired grant of the asking admin', async () => {
    const grant = (await platform.query('SELECT crm_platform_support_request($1,$2,$3,60) AS id', [accountA, admin, 'Customer reported failed sends'])).rows[0].id;
    await expect(platform.query('SELECT crm_platform_support_request($1,$2,$3,60)', [accountA, admin, 'Second open request'])).rejects.toThrow(/support_request_open/);
    await expect(platform.query('SELECT crm_platform_support_diagnostics($1,$2)', [grant, admin])).rejects.toThrow(/grant_not_active/);
    // Agents cannot see or decide; admins approve within 24 hours.
    expect(await scoped(app, accountA, ownerA, 'agent', async () => (await app.query('SELECT count(*)::int AS n FROM support_grants')).rows[0].n)).toBe(0);
    await expect(scoped(app, accountA, adminA, 'admin', () => app.query(
      "UPDATE support_grants SET status='approved', decided_by=$2, decided_at=now(), expires_at=now()+interval '25 hours' WHERE id=$1", [grant, adminA])))
      .rejects.toThrow(/check constraint/);
    await scoped(app, accountA, adminA, 'admin', () => app.query(
      "UPDATE support_grants SET status='approved', decided_by=$2, decided_at=now(), expires_at=now()+interval '1 hour' WHERE id=$1", [grant, adminA]));
    await expect(platform.query('SELECT crm_platform_support_diagnostics($1,$2)', [grant, 'other@bodhinox.test'])).rejects.toThrow(/grant_not_active/);
    const dto = (await platform.query('SELECT crm_platform_support_diagnostics($1,$2) AS d', [grant, admin])).rows[0].d;
    expect(dto).toMatchObject({ account_id: accountA, grant_id: grant });
    expect(JSON.stringify(dto)).not.toMatch(/access_token|key_secret|password|phone|body/);
    await platform.query('SELECT crm_platform_support_diagnostics($1,$2)', [grant, admin]);
    expect((await owner.query("SELECT count(*)::int AS n FROM platform_audit_log WHERE action='support.viewed' AND target_ref=$1", [grant])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action IN ('support.requested','support.viewed')", [accountA])).rows[0].n).toBe(2);
    // Revoked ends access at once; a revoked grant cannot be re-approved.
    await scoped(app, accountA, adminA, 'admin', () => app.query("UPDATE support_grants SET status='revoked', revoked_at=now() WHERE id=$1", [grant]));
    await expect(platform.query('SELECT crm_platform_support_diagnostics($1,$2)', [grant, admin])).rejects.toThrow(/grant_not_active/);
    await expect(scoped(app, accountA, adminA, 'admin', () => app.query("UPDATE support_grants SET status='approved' WHERE id=$1", [grant])))
      .rejects.toThrow(/invalid support grant transition/);
  });

  it('assigns an initial plan only to a brand-new workspace without a subscription', async () => {
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P14 fresh',$2)", [fresh, ownerA]);
    expect((await auth.query("SELECT billing_assign_initial_plan($1,'free') AS ok", [accountA])).rows[0].ok).toBe(false); // existing workspace
    expect((await auth.query("SELECT billing_assign_initial_plan($1,'free') AS ok", [fresh])).rows[0].ok).toBe(true);
    expect((await auth.query("SELECT billing_assign_initial_plan($1,'basic') AS ok", [fresh])).rows[0].ok).toBe(false); // already has a row
    const sub = await owner.query('SELECT s.plan_id, s.status, s.provider_subscription_id, v.version FROM account_subscriptions s JOIN plan_versions v ON v.id=s.plan_version_id WHERE s.account_id=$1', [fresh]);
    expect(sub.rows[0]).toEqual({ plan_id: 'free', status: 'active', provider_subscription_id: null, version: 1 });
    expect((await owner.query('SELECT count(*)::int AS n FROM account_subscriptions WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
    await expect(auth.query("SELECT billing_assign_initial_plan($1,'nope')", [fresh])).rejects.toThrow(/unknown_plan/);
  });

  it('keeps reconciliation items worker-only and resolvable only with a note', async () => {
    await scoped(worker, accountA, '', '', () => worker.query(
      "INSERT INTO billing_reconciliation_items(account_id,kind,source_ref) VALUES($1,'event_error','evt_p14') ON CONFLICT (kind, source_ref) DO NOTHING", [accountA]));
    const item = (await owner.query("SELECT id FROM billing_reconciliation_items WHERE source_ref='evt_p14'")).rows[0].id;
    await expect(platform.query("SELECT crm_platform_reconciliation_resolve($1,$2,'')", [item, admin])).rejects.toThrow(/note_required/);
    expect((await platform.query("SELECT crm_platform_reconciliation_resolve($1,$2,'Replayed the event') AS ok", [item, admin])).rows[0].ok).toBe(true);
    expect((await platform.query("SELECT crm_platform_reconciliation_resolve($1,$2,'again') AS ok", [item, admin])).rows[0].ok).toBe(false);
    await owner.query("DELETE FROM billing_reconciliation_items WHERE source_ref='evt_p14'");
    // The worker role's own checks (role grants), for completeness.
    await expect(getWorkerPrisma().$queryRaw`SELECT 1 FROM platform_audit_log LIMIT 1`).rejects.toThrow();
    await expect(getPrisma().$queryRaw`SELECT * FROM crm_platform_job_backlog()`).rejects.toThrow();
  });

  it('[audit-38] lists failed jobs without payloads and requeues one, audited, but never an uncertain send', async () => {
    const insert = async (lastError: string) => (await owner.query(
      "INSERT INTO jobs(type,tenant_id,payload,dedupe_key,status,attempts,max_attempts,last_error) VALUES('inbound.actions',$1,'{\"secret\":\"customer text\"}',$2,'failed',8,8,$3) RETURNING id",
      [accountA, `p14-requeue-${randomUUID()}`, lastError])).rows[0].id as string;
    const plain = await insert('Job execution failed; inspect correlated server logs');
    const uncertain = await insert('Provider send outcome requires reconciliation');
    const listed = (await platform.query('SELECT * FROM crm_platform_failed_jobs(200)')).rows.filter((r) => [plain, uncertain].includes(r.id));
    expect(listed).toHaveLength(2);
    for (const row of listed) expect(Object.keys(row).sort()).toEqual(['account_id', 'account_name', 'attempts', 'failed_at', 'id', 'max_attempts', 'needs_reconciliation', 'type']);
    expect(listed.find((r) => r.id === uncertain).needs_reconciliation).toBe(true);
    await expect(platform.query("SELECT crm_platform_requeue_job($1,$2,'')", [plain, admin])).rejects.toThrow(/reason_required/);
    expect((await platform.query("SELECT crm_platform_requeue_job($1,$2,'Storage is back') AS o", [uncertain, admin])).rows[0].o).toBe('needs_reconciliation');
    expect((await platform.query("SELECT crm_platform_requeue_job($1,$2,'Storage is back') AS o", [plain, admin])).rows[0].o).toBe('requeued');
    expect((await owner.query('SELECT status,attempts,last_error,lease_token FROM jobs WHERE id=$1', [plain])).rows[0])
      .toEqual({ status: 'pending', attempts: 0, last_error: null, lease_token: null });
    expect((await platform.query("SELECT crm_platform_requeue_job($1,$2,'Storage is back') AS o", [plain, admin])).rows[0].o).toBe('not_failed');
    expect((await platform.query("SELECT crm_platform_requeue_job($1,$2,'Storage is back') AS o", [randomUUID(), admin])).rows[0].o).toBe('not_found');
    expect((await owner.query("SELECT count(*)::int AS n FROM platform_audit_log WHERE action='job.requeue' AND target_ref=$1", [plain])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='job.requeue' AND resource_id=$2", [accountA, plain])).rows[0].n).toBe(1);
    // Only the platform role runs them.
    for (const c of [app, worker]) await expect(c.query("SELECT crm_platform_requeue_job($1,$2,'Storage is back')", [uncertain, admin])).rejects.toEqual(denied);
  });
});
