// Phase 14 Privacy & access on PostgreSQL with the constrained roles (app, worker,
// auth): workspace export (owner/admin only, one at a time, row and job together,
// tenant-scoped paged build, ready/download/audit, expiry sweep, failures), the
// workspace deletion request (owner, step-up, sends stop, cancel), leaving a
// workspace and creating another one.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { hashPassword } from '@/lib/auth/password';
import type { AuthContext } from '@/lib/auth/session';
import type { AccountRole } from '@/lib/auth/roles';
import { assertOutboundAllowed, suspensionReason } from '@/lib/billing/suspension';
import { leaveAccount } from '@/lib/repositories/memberships';
import type { ExportSink } from './export';
import { listWorkspaceExports, openWorkspaceExportDownload, requestWorkspaceExport } from './export';
import { cancelWorkspaceDeletion, getWorkspaceLifecycle, requestWorkspaceDeletion } from './deletion';
import { createWorkspace, MAX_OWNED_WORKSPACES } from './workspaces';
import { buildWorkspaceExport, runWorkspaceExportJob, runWorkspaceExportSweep } from '@/lib/jobs/workspace-export';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;

const password = 'A-long-test-password-42';
const A = randomUUID(), B = randomUUID(), C = randomUUID();
const owner = randomUUID(), admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), ownerB = randomUUID(), loner = randomUUID();
const users = [owner, admin, agent, viewer, ownerB, loner];
const createdAccounts: string[] = [];
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function session(userId: string, accountId: string, role: AccountRole): Promise<AuthContext> {
  const id = randomUUID();
  await q("INSERT INTO auth_sessions(id,user_id,account_id,csrf_hash,expires_at) VALUES($1,$2,$3,'x',now()+interval '1 hour')", [id, userId, accountId]);
  return {
    userId, accountId, role, sessionId: id, expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: { id: userId, email: `${userId}@example.invalid`, user_metadata: { full_name: 'Privacy' } },
  };
}

function memorySink(fail = false) {
  const state = { chunks: [] as Buffer[], finished: false, aborted: false };
  const sink: ExportSink = {
    async write(chunk) {
      if (fail) throw new Error('storage down');
      state.chunks.push(Buffer.from(chunk));
    },
    async finish() {
      state.finished = true;
      return state.chunks.reduce((n, c) => n + c.byteLength, 0);
    },
    async abort() {
      state.aborted = true;
    },
  };
  return { sink, state };
}

/** The inflated text of every zip entry (central directory walk). */
async function unzip(zip: Buffer): Promise<Map<string, string>> {
  const { inflateRawSync } = await import('node:zlib');
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0, n = zip.readUInt16LE(eocd + 10); i < n; i++) {
    const compressed = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    out.set(name, inflateRawSync(zip.subarray(start, start + compressed)).toString('utf8'));
    at += 46 + nameLength;
  }
  return out;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !authUrl)('Privacy & access on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const hash = await hashPassword(password);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) SELECT x, x::text || '@example.invalid', 'Privacy', $2, now() FROM unnest($1::uuid[]) x",
      [users, hash]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Privacy A',$2),($3,'Privacy B',$4),($5,'Privacy C',$6)", [A, owner, B, ownerB, C, agent]);
    await q(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'viewer'),
      ($6,$7,'owner'),($8,$4,'owner'),($6,$9,'agent')`, [A, owner, admin, agent, viewer, B, ownerB, C, loner]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone) SELECT gen_random_uuid(), $1, $2, 'Contact A ' || n, '9190000' || lpad(n::text, 5, '0')
      FROM generate_series(1, 5) n`, [A, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES(gen_random_uuid(),$1,$2,'Contact of B','14155550100')", [B, ownerB]);
    await q("INSERT INTO tags(id,account_id,user_id,name) VALUES(gen_random_uuid(),$1,$2,'VIP')", [A, owner]);
  }, 60_000);

  beforeEach(() => {
    for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) process.env[name] = 'configured-in-test';
    for (const name of ['BILLING_RAZORPAY_KEY_ID', 'BILLING_RAZORPAY_KEY_SECRET', 'BILLING_RAZORPAY_WEBHOOK_SECRET']) delete process.env[name];
    delete process.env.NEW_WORKSPACE_PLAN;
  });

  afterAll(async () => {
    if (!db) return;
    const accounts = [A, B, C, ...createdAccounts];
    await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [accounts]);
    await q('DELETE FROM accounts WHERE id = ANY($1::uuid[]) OR owner_user_id = ANY($2::uuid[])', [accounts, users]);
    await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [users]);
    await db.end();
    await disconnectDatabases();
  }, 60_000);

  it('lets owners and admins request one export at a time, with its job in the same transaction', async () => {
    await expect(requestWorkspaceExport(await session(agent, A, 'agent'), {})).rejects.toMatchObject({ code: 'admin_required' });
    await expect(requestWorkspaceExport(await session(viewer, A, 'viewer'), {})).rejects.toMatchObject({ code: 'admin_required' });
    delete process.env.S3_BUCKET;
    await expect(requestWorkspaceExport(await session(admin, A, 'admin'), {})).rejects.toMatchObject({ code: 'storage_not_configured' });
    process.env.S3_BUCKET = 'configured-in-test';
    const adminCtx = await session(admin, A, 'admin');
    const created = await requestWorkspaceExport(adminCtx, {});
    expect(created.status).toBe('queued');
    const job = await q("SELECT type, payload FROM jobs WHERE dedupe_key=$1", [`workspace-export:${created.id}`]);
    expect(job.rows).toEqual([{ type: 'workspace.export', payload: { exportId: created.id } }]);
    await expect(requestWorkspaceExport(await session(owner, A, 'owner'), {})).rejects.toMatchObject({ code: 'export_in_progress' });
    const audit = await q("SELECT user_id FROM audit_logs WHERE account_id=$1 AND action='workspace.export_requested' AND resource_id=$2", [A, created.id]);
    expect(audit.rows).toEqual([{ user_id: admin }]);
    // Another workspace is independent.
    const other = await requestWorkspaceExport(await session(ownerB, B, 'owner'), {});
    expect((await listWorkspaceExports(await session(ownerB, B, 'owner'))).map((e) => e.id)).toEqual([other.id]);
    await expect(listWorkspaceExports(await session(agent, A, 'agent'))).rejects.toMatchObject({ code: 'admin_required' });

    // The job builds the archive, marks it ready for 7 days and audits it.
    const { sink, state } = memorySink();
    await runWorkspaceExportJob(A, { exportId: created.id }, { attempts: 1, maxAttempts: 3 }, () => sink);
    expect(state.finished).toBe(true);
    const [ready] = await listWorkspaceExports(adminCtx);
    expect(ready).toMatchObject({ id: created.id, status: 'ready', errorCode: null });
    expect(ready.sizeBytes).toBe(state.chunks.reduce((n, c) => n + c.byteLength, 0));
    const days = (new Date(ready.expiresAt!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const key = await q('SELECT storage_key FROM workspace_exports WHERE id=$1', [created.id]);
    expect(key.rows[0].storage_key).toBe(`${A}/exports/${created.id}.zip`);
    const files = await unzip(Buffer.concat(state.chunks));
    expect(files.get('contacts.jsonl')!.trim().split('\n')).toHaveLength(5);
    expect(files.get('contacts.jsonl')).not.toContain('Contact of B');
    expect(JSON.parse(files.get('manifest.json')!)).toMatchObject({ workspace_id: A, export_id: created.id, files: { contacts: 5, tags: 1 } });

    // A second run of the same job is a no-op.
    const again = memorySink();
    await runWorkspaceExportJob(A, { exportId: created.id }, { attempts: 2, maxAttempts: 3 }, () => again.sink);
    expect(again.state.chunks).toHaveLength(0);

    // Download: admins only, audited, never another workspace's export.
    const opened = await openWorkspaceExportDownload(adminCtx, created.id);
    expect(opened.objectKey).toBe(`${A}/exports/${created.id}.zip`);
    expect(opened.filename).toMatch(/^workspace-export-\d{4}-\d{2}-\d{2}\.zip$/);
    await expect(openWorkspaceExportDownload(await session(agent, A, 'agent'), created.id)).rejects.toMatchObject({ code: 'admin_required' });
    await expect(openWorkspaceExportDownload(await session(ownerB, B, 'owner'), created.id)).rejects.toMatchObject({ code: 'export_not_found' });
    await expect(openWorkspaceExportDownload(await session(ownerB, B, 'owner'), other.id)).rejects.toMatchObject({ code: 'export_not_ready' });
    const downloads = await q("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='workspace.export_downloaded'", [A]);
    expect(downloads.rows[0].n).toBe(1);

    // Expiry: the sweep deletes the file first, then marks the row expired (kept).
    await q("UPDATE workspace_exports SET expires_at=now()-interval '1 minute' WHERE id=$1", [created.id]);
    const removed: string[] = [];
    expect(await runWorkspaceExportSweep(A, async (_a, k) => { removed.push(k); })).toEqual({ failed: 0, expired: 1 });
    expect(removed).toEqual([`${A}/exports/${created.id}.zip`]);
    const expired = await q('SELECT status, storage_key FROM workspace_exports WHERE id=$1', [created.id]);
    expect(expired.rows[0]).toEqual({ status: 'expired', storage_key: null });
    await expect(openWorkspaceExportDownload(adminCtx, created.id)).rejects.toMatchObject({ code: 'export_not_ready' });

    // B's export failed by storage: retried, then marked failed on the last attempt; the upload is aborted.
    const broken = memorySink(true);
    await expect(runWorkspaceExportJob(B, { exportId: other.id }, { attempts: 1, maxAttempts: 2 }, () => broken.sink)).rejects.toThrow('storage down');
    expect((await q('SELECT status FROM workspace_exports WHERE id=$1', [other.id])).rows[0].status).toBe('running');
    await expect(runWorkspaceExportJob(B, { exportId: other.id }, { attempts: 2, maxAttempts: 2 }, () => broken.sink)).rejects.toThrow('storage down');
    expect(broken.state.aborted).toBe(true);
    expect((await q('SELECT status, error_code FROM workspace_exports WHERE id=$1', [other.id])).rows[0]).toEqual({ status: 'failed', error_code: 'build_failed' });
  });

  it('reads only the workspace own rows, page by page, and fails exports stuck for a day', async () => {
    const { sink, state } = memorySink();
    const counts = await buildWorkspaceExport(B, randomUUID(), sink, { pageSize: 2 });
    expect(counts.contacts).toBe(1);
    const paged = memorySink();
    const countsA = await buildWorkspaceExport(A, randomUUID(), paged.sink, { pageSize: 2 });
    expect(countsA.contacts).toBe(5);
    const files = await unzip(Buffer.concat(paged.state.chunks));
    const ids = files.get('contacts.jsonl')!.trim().split('\n').map((line) => JSON.parse(line).id);
    expect(new Set(ids).size).toBe(5);
    expect((await unzip(Buffer.concat(state.chunks))).get('contacts.jsonl')).toContain('Contact of B');

    const stuck = randomUUID();
    await q("INSERT INTO workspace_exports(id,account_id,requested_by,status,created_at) VALUES($1,$2,$3,'queued',now()-interval '2 days')", [stuck, C, agent]);
    expect(await runWorkspaceExportSweep(C, async () => undefined)).toEqual({ failed: 1, expired: 0 });
    expect((await q('SELECT status, error_code FROM workspace_exports WHERE id=$1', [stuck])).rows[0]).toEqual({ status: 'failed', error_code: 'timed_out' });
    // The worker role cannot read another workspace's exports through RLS.
    const leak = await withTenant({ accountId: A, role: 'owner' }, (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM workspace_exports WHERE id=${stuck}::uuid`, getWorkerPrisma());
    expect(leak[0].n).toBe(0);
  });

  it('lets the owner request and cancel workspace deletion; sending stops while it is pending', async () => {
    await expect(requestWorkspaceDeletion(await session(admin, A, 'admin'), { password })).rejects.toMatchObject({ code: 'owner_required' });
    const ownerCtx = await session(owner, A, 'owner');
    await expect(requestWorkspaceDeletion(ownerCtx, { password: 'wrong-password-123' })).rejects.toMatchObject({ code: 'current_password_invalid' });
    const requested = await requestWorkspaceDeletion(ownerCtx, { password });
    expect(requested).toMatchObject({ status: 'closing', billingCancel: 'none' });
    const days = (new Date(requested.purgeAfter!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    // Idempotent: the date does not move.
    const repeat = await requestWorkspaceDeletion(ownerCtx, { password });
    expect(repeat.purgeAfter).toBe(requested.purgeAfter);
    expect((await getWorkspaceLifecycle(await session(viewer, A, 'viewer'))).status).toBe('closing');
    expect(await withTenant({ accountId: A, role: 'owner' }, (tx) => suspensionReason(tx, A), getWorkerPrisma())).toBe('closing');
    await expect(assertOutboundAllowed(A)).rejects.toBeTruthy();
    // Nothing is deleted.
    expect((await q('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [A])).rows[0].n).toBe(5);

    await expect(cancelWorkspaceDeletion(await session(admin, A, 'admin'))).rejects.toMatchObject({ code: 'owner_required' });
    const cancelled = await cancelWorkspaceDeletion(ownerCtx);
    expect(cancelled).toEqual({ status: 'active', deletionRequestedAt: null, purgeAfter: null });
    await expect(assertOutboundAllowed(A)).resolves.toBeUndefined();
    await expect(cancelWorkspaceDeletion(ownerCtx)).rejects.toMatchObject({ code: 'no_deletion_request' });
    const actions = await q("SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'workspace.deletion_%' ORDER BY created_at", [A]);
    expect(actions.rows.map((r) => r.action)).toEqual(['workspace.deletion_requested', 'workspace.deletion_cancelled']);

    // An admin-suspended workspace cannot be put into deletion from the tenant side.
    await q("INSERT INTO account_lifecycle(account_id,status,suspended_at,suspend_reason,suspended_by_email) VALUES($1,'admin_suspended',now(),'integration test','ops@example.invalid')", [B]);
    await expect(requestWorkspaceDeletion(await session(ownerB, B, 'owner'), { password })).rejects.toMatchObject({ code: 'workspace_admin_suspended' });
    expect((await q('SELECT status FROM account_lifecycle WHERE account_id=$1', [B])).rows[0].status).toBe('admin_suspended');

    // A support hold on a closing workspace: the owner cannot cancel the deletion until it is lifted.
    await requestWorkspaceDeletion(ownerCtx, { password });
    await q("UPDATE account_lifecycle SET suspended_at=now(), suspend_reason='Abuse while closing', suspended_by_email='ops@example.invalid' WHERE account_id=$1", [A]);
    await expect(cancelWorkspaceDeletion(ownerCtx)).rejects.toMatchObject({ code: 'workspace_admin_suspended' });
    expect((await q('SELECT status FROM account_lifecycle WHERE account_id=$1', [A])).rows[0].status).toBe('closing');
    await q('UPDATE account_lifecycle SET suspended_at=NULL, suspend_reason=NULL, suspended_by_email=NULL WHERE account_id=$1', [A]);
    await expect(cancelWorkspaceDeletion(ownerCtx)).resolves.toMatchObject({ status: 'active' });
  });

  it('lets a non-owner leave, moving the session and revoking the others; refuses owners and a last workspace', async () => {
    await expect(leaveAccount(await session(owner, A, 'owner'))).rejects.toMatchObject({ code: 'owner_must_transfer' });
    await expect(leaveAccount(await session(loner, B, 'agent'))).rejects.toMatchObject({ code: 'last_workspace' });
    const current = await session(agent, A, 'agent');
    const otherDevice = await session(agent, A, 'agent');
    const { nextAccountId } = await leaveAccount(current);
    expect(nextAccountId).toBe(C);
    expect((await q('SELECT count(*)::int AS n FROM account_memberships WHERE account_id=$1 AND user_id=$2', [A, agent])).rows[0].n).toBe(0);
    const sessions = await q('SELECT id, account_id, revoked_at IS NOT NULL AS revoked FROM auth_sessions WHERE id = ANY($1::uuid[])',
      [[current.sessionId, otherDevice.sessionId]]);
    const byId = new Map(sessions.rows.map((r) => [r.id, r]));
    expect(byId.get(current.sessionId)).toMatchObject({ account_id: C, revoked: false });
    expect(byId.get(otherDevice.sessionId)).toMatchObject({ revoked: true });
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='membership.leave' AND user_id=$2", [A, agent])).rows[0].n).toBe(1);
  });

  it('creates another workspace owned by the caller, with a per-owner cap', async () => {
    const ctx = await session(loner, B, 'agent');
    await expect(createWorkspace(ctx, '   ')).rejects.toMatchObject({ code: 'invalid_name' });
    const created = await createWorkspace(ctx, '  Second   business ');
    createdAccounts.push(created.accountId);
    expect(created.name).toBe('Second business');
    const row = await q('SELECT a.name, a.owner_user_id, m.role FROM accounts a JOIN account_memberships m ON m.account_id=a.id AND m.user_id=$2 WHERE a.id=$1',
      [created.accountId, loner]);
    expect(row.rows).toEqual([{ name: 'Second business', owner_user_id: loner, role: 'owner' }]);
    // NEW_WORKSPACE_PLAN is unset here: the workspace starts on the lowest plan, never the unrestricted default (audit finding 41).
    expect((await q('SELECT plan_id FROM account_subscriptions WHERE account_id=$1', [created.accountId])).rows).toEqual([{ plan_id: 'free' }]);
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='workspace.created'", [created.accountId])).rows[0].n).toBe(1);

    const filler = await q(`WITH a AS (INSERT INTO accounts(id,name,owner_user_id) SELECT gen_random_uuid(), 'Filler', $1 FROM generate_series(2, $2) RETURNING id)
      INSERT INTO account_memberships(account_id,user_id,role) SELECT id, $1, 'owner' FROM a RETURNING account_id`, [loner, MAX_OWNED_WORKSPACES]);
    createdAccounts.push(...filler.rows.map((r) => r.account_id));
    await expect(createWorkspace(ctx, 'One too many')).rejects.toMatchObject({ code: 'workspace_limit' });
  });
});
