// Phase 14 T4 on a real PostgreSQL: consented support access end to end
// (request, approve/deny/revoke, proactive grants, expiry, one open grant per
// admin), diagnostics only with an approved grant and only for that
// workspace, no customer content or secrets in the diagnostics or in the
// tenant health card, the tenant audit trail, and admin suspension / manual
// block with distinct codes that never touch billing suspension.
// Runs only against an isolated *test* database.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { assertOutboundAllowed, suspensionReason, WorkspaceSuspendedError } from '@/lib/billing/suspension';
import { platformSupportDiagnostics, platformSupportGrants, platformSupportRequest } from './db';
import { loadIntegrationHealth } from './health';
import { changeLifecycle, manualRepliesBlocked } from './lifecycle';
import { createProactiveGrant, decideSupportGrant, listSupportGrants } from './support';
import { getTenant, listTenants } from './tenants';
import { listReconciliation } from './billing';
import type { PlatformAdmin } from '@/types/platform';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const platformUrl = process.env.TEST_PLATFORM_DATABASE_URL || configured?.PLATFORM_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (platformUrl) process.env.PLATFORM_DATABASE_URL = platformUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const tag = randomUUID().slice(0, 8);
const opsEmail = `ops-${tag}@bodhinox.test`, otherOps = `ops2-${tag}@bodhinox.test`;
const env = { PLATFORM_ADMIN_EMAILS: `${opsEmail},${otherOps}` };
const ops: PlatformAdmin = { userId: randomUUID(), sessionId: randomUUID(), email: opsEmail };
// Customer content and secrets that must never reach a platform admin or the health card.
const SECRET = { token: `EAAG-secret-${tag}`, keySecret: `enc:rzp-secret-${tag}`, contactName: `Priya ${tag}`, phone: `9198${tag.replace(/\D/g, '1').padEnd(8, '1').slice(0, 8)}`,
  body: `private message body ${tag}` };
const adminA_: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const agentA_: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const ownerB_: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !platformUrl)('Platform console (T4) on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    Object.assign(process.env, env);
    for (const id of [ownerA, adminA, agentA, ownerB, ownerC])
      await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'T4','test-only-hash')", [id, `${id}@example.invalid`]);
    for (const [id, o, name] of [[accountA, ownerA, `T4 A ${tag}`], [accountB, ownerB, `T4 B ${tag}`], [accountC, ownerC, `T4 C ${tag}`]])
      await owner.query('INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)', [id, name, o]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner'),($7,$8,'owner')`,
    [accountA, ownerA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    // Workspace A: a connected number with a token, a commerce Razorpay key, a contact and a message.
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status,display_name,health_error,health_error_at)
      VALUES($1,$2,$3,$4,'connected','Main line','token',now())`, [accountA, ownerA, `pn${tag}`, SECRET.token]);
    await owner.query("INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test',$2,$3)",
      [accountA, `rzp_test_${tag}`, SECRET.keySecret]);
    const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
      [accountA, ownerA, SECRET.phone, SECRET.contactName])).rows[0].id;
    const conversation = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
      [accountA, ownerA, contact])).rows[0].id;
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_text) VALUES($1,$2,'customer',$3)",
      [accountA, conversation, SECRET.body]);
    // Workspace C: billing-suspended.
    await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,'free','suspended')", [accountC]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, adminA, agentA, ownerB, ownerC]]);
      // platform_audit_log is append-only by design: its test rows stay.
      await owner.end().catch(() => {});
    }
    await disconnectDatabases();
  });

  const actorA = { accountId: accountA, userId: adminA };
  const tenantAudit = async (account: string) =>
    (await owner.query('SELECT action, user_id, metadata FROM audit_logs WHERE account_id=$1 AND action LIKE $2 ORDER BY created_at, id', [account, 'support.%'])).rows;

  it('runs a support request through approval, diagnostics (no content, no secrets), revocation and the tenant audit trail', async () => {
    const grantId = await platformSupportRequest({ accountId: accountA, adminEmail: opsEmail, reason: 'Customer reports failed sends', minutes: 60 });
    // Not approved yet: no diagnostics.
    await expect(platformSupportDiagnostics(grantId, opsEmail)).rejects.toMatchObject({ code: 'grant_not_active', status: 403 });

    // Only owners and admins of workspace A see or decide it.
    expect(await withTenant(agentA_, (tx) => listSupportGrants(tx, accountA))).toEqual([]);
    expect(await withTenant(ownerB_, (tx) => listSupportGrants(tx, accountB))).toEqual([]);
    await expect(withTenant(ownerB_, (tx) => decideSupportGrant(tx, { accountId: accountB, userId: ownerB }, grantId, { action: 'approve', minutes: null })))
      .rejects.toMatchObject({ code: 'not_found' });
    const [listed] = await withTenant(adminA_, (tx) => listSupportGrants(tx, accountA));
    expect(listed).toMatchObject({ id: grantId, status: 'requested', requestedByEmail: opsEmail, actionable: true });

    // Approving for longer than asked grants what was asked.
    const approved = await withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, grantId, { action: 'approve', minutes: 1440 }));
    expect(approved.status).toBe('approved');
    expect(new Date(approved.expiresAt!).getTime() - new Date(approved.decidedAt!).getTime()).toBe(60 * 60_000);
    await expect(withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, grantId, { action: 'deny' }))).rejects.toMatchObject({ code: 'not_pending' });

    // Another admin's email, or another workspace's grant id, gets nothing.
    await expect(platformSupportDiagnostics(grantId, otherOps)).rejects.toMatchObject({ code: 'grant_not_active' });
    await expect(platformSupportDiagnostics(randomUUID(), opsEmail)).rejects.toMatchObject({ code: 'grant_not_active' });

    const dto = await platformSupportDiagnostics(grantId, opsEmail);
    expect(dto.account_id).toBe(accountA);
    expect(Object.keys(dto).sort()).toEqual(['account_id', 'billing_intents', 'expires_at', 'failed_jobs', 'grant_id', 'integrations', 'lifecycle',
      'open_payment_exceptions', 'open_reconciliation_items', 'outbound_intents', 'settings', 'subscription', 'usage', 'whatsapp_numbers']);
    expect(Object.keys(dto.whatsapp_numbers[0]).sort()).toEqual(['has_token', 'health_checked_at', 'health_error_at', 'id', 'messaging_limit_tier',
      'quality_rating', 'registered', 'status']);
    const text = JSON.stringify(dto);
    for (const value of Object.values(SECRET)) expect(text).not.toContain(value);
    expect(text).not.toContain(`rzp_test_${tag}`);

    // The platform list shows the grant to its admin only.
    expect((await platformSupportGrants(opsEmail, accountA)).map((g) => g.status)).toEqual(['approved']);
    expect(await platformSupportGrants(otherOps, accountA)).toEqual([]);

    await withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, grantId, { action: 'revoke' }));
    await expect(platformSupportDiagnostics(grantId, opsEmail)).rejects.toMatchObject({ code: 'grant_not_active' });
    await expect(withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, grantId, { action: 'revoke' }))).rejects.toMatchObject({ code: 'not_active' });

    // Tenant audit trail, readable by the workspace's admins through the app role.
    expect((await tenantAudit(accountA)).map((r) => r.action)).toEqual(['support.requested', 'support.approved', 'support.viewed', 'support.revoked']);
    const visible = await withTenant(adminA_, (tx) => tx.$queryRaw<{ action: string }[]>`
      SELECT action FROM audit_logs WHERE account_id=${accountA}::uuid AND action LIKE 'support.%'`);
    expect(visible).toHaveLength(4);
    const decided = (await tenantAudit(accountA)).filter((r) => r.action === 'support.approved' || r.action === 'support.revoked');
    expect(decided.every((r) => r.user_id === adminA)).toBe(true);
  });

  it('denies requests, refuses stale ones and keeps one open grant per admin', async () => {
    const grantId = await platformSupportRequest({ accountId: accountA, adminEmail: opsEmail, reason: 'Checking a webhook backlog', minutes: 30 });
    await expect(platformSupportRequest({ accountId: accountA, adminEmail: opsEmail, reason: 'A second open request', minutes: 30 }))
      .rejects.toMatchObject({ code: 'support_request_open' });
    expect((await withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, grantId, { action: 'deny' }))).status).toBe('denied');
    await expect(platformSupportDiagnostics(grantId, opsEmail)).rejects.toMatchObject({ code: 'grant_not_active' });

    // A request nobody answered for more than 7 days can no longer be approved.
    const stale = (await owner.query(`INSERT INTO support_grants(account_id,requested_by_email,reason,requested_at)
      VALUES($1,$2,'An old unanswered request',now()-interval '8 days') RETURNING id`, [accountA, otherOps])).rows[0].id;
    await expect(withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, stale, { action: 'approve', minutes: null })))
      .rejects.toMatchObject({ code: 'request_expired' });
    expect((await withTenant(adminA_, (tx) => listSupportGrants(tx, accountA))).find((g) => g.id === stale)).toMatchObject({ status: 'expired', actionable: false });
    // ...and does not block a proactive grant to the same admin.
    const proactive = await withTenant(adminA_, (tx) =>
      createProactiveGrant(tx, actorA, { email: otherOps, reason: 'Please look at our failed jobs', minutes: 15 }));
    expect(proactive).toMatchObject({ status: 'approved', requestedByEmail: otherOps });
    await expect(withTenant(adminA_, (tx) =>
      createProactiveGrant(tx, actorA, { email: otherOps, reason: 'A second grant at once', minutes: 15 }))).rejects.toMatchObject({ code: 'grant_open' });
    // A grant to an address outside the allowlist looks the same to the tenant, and is inert.
    const inert = await withTenant(adminA_, (tx) =>
      createProactiveGrant(tx, actorA, { email: `someone-${tag}@example.invalid`, reason: 'Not a Bodhinox admin', minutes: 15 }));
    expect(inert).toMatchObject({ status: 'approved' });
    // An agent cannot grant access (RLS).
    await expect(withTenant(agentA_, (tx) =>
      createProactiveGrant(tx, { accountId: accountA, userId: agentA }, { email: opsEmail, reason: 'Agent tries to grant', minutes: 15 }))).rejects.toThrow();
    expect((await platformSupportDiagnostics(proactive.id, otherOps)).account_id).toBe(accountA);

    // The window passes: diagnostics stop, the grant reads as expired, and a new grant is possible.
    await owner.query("UPDATE support_grants SET decided_at=now()-interval '2 hours', expires_at=now()-interval '1 minute' WHERE id=$1", [proactive.id]);
    await expect(platformSupportDiagnostics(proactive.id, otherOps)).rejects.toMatchObject({ code: 'grant_not_active' });
    expect((await withTenant(adminA_, (tx) => listSupportGrants(tx, accountA))).find((g) => g.id === proactive.id)?.status).toBe('expired');
    await expect(withTenant(adminA_, (tx) => decideSupportGrant(tx, actorA, proactive.id, { action: 'revoke' }))).rejects.toMatchObject({ code: 'not_active' });
    expect((await withTenant(adminA_, (tx) =>
      createProactiveGrant(tx, actorA, { email: otherOps, reason: 'Another look after expiry', minutes: 15 }))).status).toBe('approved');
    expect((await owner.query("SELECT status FROM support_grants WHERE id=$1", [proactive.id])).rows[0].status).toBe('expired');
  });

  it('suspends and blocks through the platform with their own codes, independent of billing suspension', async () => {
    expect(await withTenant(ownerB_, (tx) => suspensionReason(tx, accountB))).toBeNull();
    await assertOutboundAllowed(accountB);
    expect(await manualRepliesBlocked(ownerB_)).toBe(false);

    await changeLifecycle(ops, { accountId: accountB, status: 'admin_suspended', blockManual: true, reason: 'Abuse report under review' });
    const refusal = await assertOutboundAllowed(accountB).catch((e) => e);
    expect(refusal).toBeInstanceOf(WorkspaceSuspendedError);
    expect(refusal).toMatchObject({ status: 402, code: 'workspace_admin_suspended', reason: 'admin' });
    expect(await manualRepliesBlocked(ownerB_)).toBe(true);
    expect(await manualRepliesBlocked(adminA_)).toBe(false);
    // Notified and audited in the workspace.
    expect((await owner.query("SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND type='billing'", [accountB])).rows[0].n).toBe(1);
    expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='lifecycle.admin_suspended'", [accountB])).rows[0].n).toBe(1);

    // Billing suspension keeps today's code; the admin suspension never changed the subscription.
    expect(await assertOutboundAllowed(accountC).catch((e) => e)).toMatchObject({ code: 'plan_limit', reason: 'billing' });
    expect((await owner.query('SELECT count(*)::int AS n FROM account_subscriptions WHERE account_id=$1', [accountB])).rows[0].n).toBe(0);

    // Manual block without suspension: automatic sending allowed, manual replies refused.
    await changeLifecycle(ops, { accountId: accountB, status: 'active', blockManual: true, reason: 'Sending allowed, inbox replies paused' });
    await assertOutboundAllowed(accountB);
    expect(await manualRepliesBlocked(ownerB_)).toBe(true);
    await changeLifecycle(ops, { accountId: accountB, status: 'active', blockManual: false, reason: 'Review finished, all clear' });
    expect(await manualRepliesBlocked(ownerB_)).toBe(false);

    // Suspending a billing-suspended workspace and reactivating it leaves billing suspension in place.
    await changeLifecycle(ops, { accountId: accountC, status: 'admin_suspended', blockManual: false, reason: 'Chargeback investigation' });
    expect(await withTenant({ accountId: accountC, role: 'owner' }, (tx) => suspensionReason(tx, accountC))).toBe('admin');
    await changeLifecycle(ops, { accountId: accountC, status: 'active', blockManual: false, reason: 'Chargeback investigation closed' });
    expect(await withTenant({ accountId: accountC, role: 'owner' }, (tx) => suspensionReason(tx, accountC))).toBe('billing');

    // A closing workspace (owner's deletion request) stops sending with its own code. The console can
    // still hold it and block manual replies; the status and the purge countdown stay the owner's.
    await owner.query("INSERT INTO account_lifecycle(account_id,status,deletion_requested_at,deletion_requested_by,purge_after) VALUES($1,'closing',now(),$2,now()-interval '1 day')",
      [accountA, ownerA]);
    expect(await assertOutboundAllowed(accountA).catch((e) => e)).toMatchObject({ code: 'workspace_closing', reason: 'closing' });
    expect(await manualRepliesBlocked(adminA_)).toBe(false);
    await changeLifecycle(ops, { accountId: accountA, status: 'admin_suspended', blockManual: true, reason: 'Abuse while the deletion is pending' });
    expect(await manualRepliesBlocked(adminA_)).toBe(true);
    const heldRow = (await owner.query('SELECT status, suspend_reason, purge_after IS NOT NULL AS purge FROM account_lifecycle WHERE account_id=$1', [accountA])).rows[0];
    expect(heldRow).toEqual({ status: 'closing', suspend_reason: 'Abuse while the deletion is pending', purge: true });
    await changeLifecycle(ops, { accountId: accountA, status: 'active', blockManual: false, reason: 'Hold lifted, deletion continues' });
    expect((await owner.query('SELECT status, suspend_reason, block_manual FROM account_lifecycle WHERE account_id=$1', [accountA])).rows[0])
      .toEqual({ status: 'closing', suspend_reason: null, block_manual: false });
    const page = await listTenants({ search: `T4 A ${tag}`, cursor: null, limit: 10 });
    expect(page.tenants).toEqual([expect.objectContaining({ accountId: accountA, lifecycleStatus: 'closing', purgeDue: true })]);
    expect((await getTenant(accountB))?.lifecycle).toMatchObject({ status: 'active', block_manual: false });
    expect(await getTenant(randomUUID())).toBeNull();
    await owner.query('DELETE FROM account_lifecycle WHERE account_id=$1', [accountA]);
  });

  it('audits a manual-block toggle as such, keeps the suspension metadata, and never forces the block on suspend', async () => {
    const actions = async () => (await owner.query("SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'lifecycle.%' ORDER BY created_at, id", [accountB])).rows.map((r) => r.action);
    const before = (await actions()).length;
    const notices = async () => (await owner.query("SELECT title FROM notifications WHERE account_id=$1 AND type='billing' ORDER BY created_at, id", [accountB])).rows.map((r) => r.title);
    const noticesBefore = (await notices()).length;
    // Suspend with the box unticked: manual replies stay allowed, and reactivating leaves nothing blocked.
    await changeLifecycle(ops, { accountId: accountB, status: 'admin_suspended', blockManual: false, reason: 'Second abuse report' });
    expect(await manualRepliesBlocked(ownerB_)).toBe(false);
    const first = (await owner.query('SELECT suspended_at, suspend_reason, suspended_by_email FROM account_lifecycle WHERE account_id=$1', [accountB])).rows[0];
    // Toggling the block on a suspended workspace keeps who suspended it, when and why.
    await changeLifecycle(ops, { accountId: accountB, status: 'admin_suspended', blockManual: true, reason: 'Inbox abuse seen as well' });
    expect((await owner.query('SELECT suspended_at, suspend_reason, suspended_by_email FROM account_lifecycle WHERE account_id=$1', [accountB])).rows[0]).toEqual(first);
    expect(await manualRepliesBlocked(ownerB_)).toBe(true);
    // The same request again changes nothing and writes nothing.
    await changeLifecycle(ops, { accountId: accountB, status: 'admin_suspended', blockManual: true, reason: 'Inbox abuse seen as well' });
    await changeLifecycle(ops, { accountId: accountB, status: 'active', blockManual: false, reason: 'All clear after review' });
    await changeLifecycle(ops, { accountId: accountB, status: 'active', blockManual: true, reason: 'Inbox replies paused only' });
    expect((await actions()).slice(before)).toEqual(['lifecycle.admin_suspended', 'lifecycle.manual_blocked', 'lifecycle.reactivated', 'lifecycle.manual_blocked']);
    const sent = (await notices()).slice(noticesBefore);
    expect(sent).toEqual(['Workspace suspended by Bodhinox support', 'Manual replies blocked by Bodhinox support', 'Workspace reactivated',
      'Manual replies blocked by Bodhinox support']);
    await changeLifecycle(ops, { accountId: accountB, status: 'active', blockManual: false, reason: 'Inbox replies allowed again' });
    expect((await actions()).at(-1)).toBe('lifecycle.manual_unblocked');
  });

  it('pages reconciliation items that share opened_at without skipping any', async () => {
    await owner.query(`INSERT INTO billing_reconciliation_items(account_id,kind,source_ref,detail)
      SELECT $1,'state_mismatch','page-' || $2 || '-' || n,'{}'::jsonb FROM generate_series(1,5) n`, [accountC, tag]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const params = new URLSearchParams({ status: 'all', limit: '2', ...(cursor ? { cursor } : {}) });
      const page = await listReconciliation(params);
      seen.push(...page.items.filter((it) => it.sourceRef.startsWith(`page-${tag}-`)).map((it) => it.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);
  });

  it('shows members the integration health of their own workspace only, without tokens or secrets', async () => {
    const rows = await withTenant(agentA_, (tx) => loadIntegrationHealth(tx, accountA));
    expect(rows.map((r) => r.kind).sort()).toEqual(['razorpay', 'whatsapp']);
    expect(rows.find((r) => r.kind === 'whatsapp')).toMatchObject({ label: 'Main line', state: 'attention', lastErrorCode: 'token', href: '/settings?tab=whatsapp' });
    const text = JSON.stringify(rows);
    for (const value of Object.values(SECRET)) expect(text).not.toContain(value);
    expect(text).not.toContain(`rzp_test_${tag}`);
    expect(await withTenant(ownerB_, (tx) => loadIntegrationHealth(tx, accountA))).toEqual([]);
    expect(await withTenant(ownerB_, (tx) => loadIntegrationHealth(tx, accountB))).toEqual([]);
  });
});
