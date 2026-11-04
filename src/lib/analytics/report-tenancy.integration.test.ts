// Phase 12 report artifacts on PostgreSQL: shares cannot escape the workspace
// or the live role, scheduled runs recheck the creator and every recipient,
// a period runs once, and PDF runs store under a .pdf key.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ puts: new Map<string, Uint8Array>(), mails: [] as { to: string; text: string }[] }));
vi.mock('./report-storage', async (original) => ({
  ...(await original<typeof import('./report-storage')>()),
  putReportFile: async (_a: string, key: string, body: Uint8Array) => { files.puts.set(key, body); },
  deleteReportFile: async () => {},
}));
vi.mock('@/lib/auth/email', () => ({
  authEmailTransport: () => ({ sendMail: async (m: { to: string; text: string }) => { files.mails.push(m); }, close: () => {} }),
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { requestReport, runReportJob } from './reports';
import { createSchedule, deleteSchedule, runReportSchedules, updateSchedule } from './report-schedules';
import { createShare, openShare, peekShare, revokeShare } from './report-shares';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), adminA2 = randomUUID(), adminA3 = randomUUID(), agentA = randomUUID(), viewerA = randomUUID();
const ownerB = randomUUID(), dual = randomUUID();
const users = [ownerA, adminA2, adminA3, agentA, viewerA, ownerB, dual];
const ctx = (accountId: string, userId: string, role: TenantContext['role']) => ({ accountId, userId, role: role! });
const owner = ctx(A, ownerA, 'owner');
const viewer = ctx(A, viewerA, 'viewer');
const agent = ctx(A, agentA, 'agent');
const custom = { preset: 'custom', from: '2026-10-01', to: '2026-10-07' };
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const asApp = <T>(c: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(c, op);
const asWorker = <T>(op: Parameters<typeof withTenant<T>>[1]) => withTenant({ accountId: A, role: 'owner' }, op, getWorkerPrisma());
const makeDue = (id: string) => asWorker((tx) => tx.$executeRaw`UPDATE report_schedules SET next_run_at=now() - interval '1 minute'
  WHERE account_id=${A}::uuid AND id=${id}::uuid`);

async function readyReport(kind: string, format: 'csv' | 'pdf' = 'csv'): Promise<string> {
  const run = await requestReport(owner, { kind, range: custom, format });
  await runReportJob(A, { reportId: run.id });
  return run.id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('report shares and schedules on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Reports', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [users]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Shares A',$2),($3,'Shares B',$4)", [A, ownerA, B, ownerB]);
    await q(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'admin'),($1,$5,'agent'),($1,$6,'viewer'),($1,$9,'viewer'),($7,$8,'owner'),($7,$9,'owner')`,
    [A, ownerA, adminA2, adminA3, agentA, viewerA, B, ownerB, dual]);
    await q(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES
      ($1,'Olu','olu@example.invalid',$4,'owner'),($2,'Ada','ada@example.invalid',$4,'admin'),($3,'Ari','ari@example.invalid',$4,'admin')
      ON CONFLICT (user_id) DO UPDATE SET full_name=EXCLUDED.full_name, email=EXCLUDED.email`, [ownerA, adminA2, adminA3, A]);
    Object.assign(process.env, { SMTP_URL: 'smtp://x', AUTH_EMAIL_FROM: 'reports@bodhinox.test', APP_URL: 'https://app.bodhinox.test' });
  });

  afterAll(async () => {
    delete process.env.SMTP_URL;
    delete process.env.AUTH_EMAIL_FROM;
    delete process.env.APP_URL;
    if (db) {
      await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('builds a PDF run under a .pdf key', async () => {
    const id = await readyReport('product_summary', 'pdf');
    const row = (await q('SELECT status, format, object_key FROM report_runs WHERE id=$1', [id])).rows[0];
    expect(row).toEqual({ status: 'ready', format: 'pdf', object_key: `${A}/reports/${id}.pdf` });
    expect(new TextDecoder().decode(files.puts.get(row.object_key)!.slice(0, 5))).toBe('%PDF-');
  });

  it('opens a viewer share for a viewer, counts and audits it, and never across workspaces', async () => {
    const run = await readyReport('campaign_summary');
    const share = await createShare(owner, run, { minRole: 'viewer', expiresInHours: 24 });
    // Peeking (the share page's details) applies the same checks and counts nothing.
    const peek = await peekShare(viewer, share.id);
    expect(peek).toMatchObject({ kind: 'campaign_summary', format: 'csv' });
    expect(new Date(peek.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await expect(peekShare(ctx(B, ownerB, 'owner'), share.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(peekShare(ctx(B, dual, 'owner'), share.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await q('SELECT open_count FROM report_shares WHERE id=$1', [share.id])).rows[0].open_count).toBe(0);
    // The definer function works under FORCE RLS and returns the row.
    expect(await openShare(viewer, share.id)).toMatchObject({ objectKey: `${A}/reports/${run}.csv`, format: 'csv' });
    const counted = (await q('SELECT open_count FROM report_shares WHERE id=$1', [share.id])).rows[0];
    expect(counted.open_count).toBe(1);
    const audits = await q("SELECT user_id::text AS user_id FROM audit_logs WHERE account_id=$1 AND action='analytics.report_share_opened'", [A]);
    expect(audits.rows).toEqual([{ user_id: viewerA }]);

    // Another workspace's owner, and an A member whose live session is on B, both get nothing.
    await expect(openShare(ctx(B, ownerB, 'owner'), share.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(openShare(ctx(B, dual, 'owner'), share.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await q('SELECT open_count FROM report_shares WHERE id=$1', [share.id])).rows[0].open_count).toBe(1);

    // Revoked: gone for everyone.
    await revokeShare(owner, run, share.id);
    await expect(openShare(viewer, share.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(peekShare(viewer, share.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps an agent share from viewers and refuses a share below the kind minimum', async () => {
    const run = await readyReport('commerce_daily');
    await expect(createShare(owner, run, { minRole: 'viewer', expiresInHours: 24 })).rejects.toMatchObject({ code: 'role_too_low' });
    const share = await createShare(owner, run, { minRole: 'agent', expiresInHours: 24 });
    await expect(openShare(viewer, share.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(peekShare(viewer, share.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await openShare(agent, share.id)).toMatchObject({ format: 'csv' });
    // Agents cannot list or create shares, even directly in SQL.
    expect(await asApp(agent, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM report_shares`)).toEqual([]);
    await expect(asApp(agent, (tx) => tx.$executeRaw`INSERT INTO report_shares(account_id,report_run_id,min_role,created_by,expires_at)
      VALUES(${A}::uuid,${run}::uuid,'viewer',${agentA}::uuid,now() + interval '1 hour')`)).rejects.toThrow();
  });

  it('refuses expired shares and shares of expired reports', async () => {
    const run = await readyReport('agent_performance');
    const expiring = await createShare(owner, run, { minRole: 'viewer', expiresInHours: 1 });
    await q("UPDATE report_shares SET created_at=now() - interval '2 hours', expires_at=now() - interval '1 minute' WHERE id=$1", [expiring.id]);
    await expect(openShare(viewer, expiring.id)).rejects.toMatchObject({ code: 'not_found' });

    const live = await createShare(owner, run, { minRole: 'viewer', expiresInHours: 24 });
    await q("UPDATE report_runs SET expires_at=now() - interval '1 minute' WHERE id=$1", [run]);
    await expect(openShare(viewer, live.id)).rejects.toMatchObject({ code: 'not_found' });
    // The share can never be created past the report's own expiry either.
    const other = await readyReport('member_campaigns');
    await q("UPDATE report_runs SET expires_at=now() + interval '2 hours' WHERE id=$1", [other]);
    const capped = await createShare(owner, other, { minRole: 'viewer', expiresInHours: 168 });
    expect(Date.parse(capped.expiresAt)).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000 + 60_000);
  });

  it('keeps schedules to admins of the workspace (RLS)', async () => {
    const schedule = await createSchedule(owner, { kind: 'campaign_daily', cadence: 'daily', recipients: [ownerA] });
    expect(await asApp(ctx(B, ownerB, 'owner'), (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM report_schedules WHERE id=${schedule.id}::uuid`)).toEqual([]);
    expect(await asApp(viewer, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM report_schedules`)).toEqual([]);
    expect(await asApp(agent, (tx) => tx.$executeRaw`UPDATE report_schedules SET hour_local=3`)).toBe(0);
    // Recipients must be current admins or owners.
    await expect(createSchedule(owner, { kind: 'campaign_daily', cadence: 'daily', recipients: [viewerA] }))
      .rejects.toMatchObject({ code: 'invalid_recipients' });
    await expect(createSchedule(owner, { kind: 'campaign_daily', cadence: 'daily', recipients: [ownerB] }))
      .rejects.toMatchObject({ code: 'invalid_recipients' });
    await updateSchedule(owner, schedule.id, { paused: true });
    const row = (await q('SELECT paused_at IS NOT NULL AS paused, pause_reason FROM report_schedules WHERE id=$1', [schedule.id])).rows[0];
    expect(row).toEqual({ paused: true, pause_reason: 'manual' });
  });

  it('runs a schedule once per period, emails current admin recipients and audits the removed one', async () => {
    const schedule = await createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: [ownerA, adminA3] });
    await makeDue(schedule.id);
    const results = await runReportSchedules(A);
    expect(results).toContainEqual({ id: schedule.id, outcome: 'queued' });
    const runs = await q('SELECT id::text AS id, requested_by::text AS requested_by, email_requested FROM report_runs WHERE schedule_id=$1', [schedule.id]);
    expect(runs.rows).toEqual([{ id: runs.rows[0].id, requested_by: ownerA, email_requested: true }]);
    const runId = runs.rows[0].id as string;
    expect((await q('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [`analytics-report:${runId}`])).rows[0].n).toBe(1);
    expect((await q('SELECT next_run_at > now() AS future FROM report_schedules WHERE id=$1', [schedule.id])).rows[0].future).toBe(true);

    // The same period again is a no-op.
    await makeDue(schedule.id);
    expect(await runReportSchedules(A)).toContainEqual({ id: schedule.id, outcome: 'repeat' });
    expect((await q('SELECT count(*)::int AS n FROM report_runs WHERE schedule_id=$1', [schedule.id])).rows[0].n).toBe(1);

    // A recipient removed before delivery is skipped and audited by id only.
    await q('DELETE FROM account_memberships WHERE account_id=$1 AND user_id=$2', [A, adminA3]);
    files.mails = [];
    await runReportJob(A, { reportId: runId });
    expect(files.mails.map((m) => m.to)).toEqual(['olu@example.invalid']);
    expect(files.mails[0].text).toContain(`https://app.bodhinox.test/api/analytics/reports/${runId}/download`);
    const skipped = await q("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='analytics.report_delivery_skipped' AND resource_id=$2",
      [A, runId]);
    expect(skipped.rows).toEqual([{ user_id: null, metadata: { recipient: adminA3 } }]);
    // A redelivered job sends nothing more.
    await runReportJob(A, { reportId: runId });
    expect(files.mails).toHaveLength(1);
    const intents = await q('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2', [A, `%report-email:${runId}:%`]);
    expect(intents.rows[0].n).toBe(1);
  });

  it('still queues the first weekly report after a daily schedule whose last period started the same day', async () => {
    const schedule = await createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: [ownerA] });
    const dueBy = (at: Date) => asWorker((tx) => tx.$executeRaw`UPDATE report_schedules SET next_run_at=${new Date(at.getTime() - 60_000)}
      WHERE account_id=${A}::uuid AND id=${schedule.id}::uuid`);
    // Tuesday: the daily period is Monday 2 Nov.
    const tuesday = new Date('2026-11-03T09:00:00Z');
    await dueBy(tuesday);
    expect(await runReportSchedules(A, tuesday)).toContainEqual({ id: schedule.id, outcome: 'queued' });
    await updateSchedule(owner, schedule.id, { cadence: 'weekly' });
    // Next Monday: the weekly period is 2-8 Nov, which also starts on 2 Nov.
    const monday = new Date('2026-11-09T09:00:00Z');
    await dueBy(monday);
    expect(await runReportSchedules(A, monday)).toContainEqual({ id: schedule.id, outcome: 'queued' });
    const periods = (await q("SELECT params->>'from' AS f, params->>'to' AS t FROM report_runs WHERE schedule_id=$1 ORDER BY created_at", [schedule.id])).rows;
    expect(periods).toEqual([{ f: '2026-11-02', t: '2026-11-02' }, { f: '2026-11-02', t: '2026-11-08' }]);
  });

  it('emails nobody when the schedule is deleted while its run is in flight', async () => {
    const schedule = await createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: [ownerA] });
    await makeDue(schedule.id);
    expect(await runReportSchedules(A)).toContainEqual({ id: schedule.id, outcome: 'queued' });
    const runId = (await q('SELECT id::text AS id FROM report_runs WHERE schedule_id=$1', [schedule.id])).rows[0].id as string;
    const payload = (await q('SELECT payload FROM jobs WHERE dedupe_key=$1', [`analytics-report:${runId}`])).rows[0].payload;
    expect(payload).toEqual({ reportId: runId, scheduled: true });
    await deleteSchedule(owner, schedule.id);
    expect((await q('SELECT schedule_id FROM report_runs WHERE id=$1', [runId])).rows[0].schedule_id).toBeNull();
    files.mails = [];
    await runReportJob(A, payload);
    expect(files.mails).toEqual([]);
    expect((await q('SELECT status FROM report_runs WHERE id=$1', [runId])).rows[0].status).toBe('ready');
    const intents = await q('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2', [A, `%report-email:${runId}%`]);
    expect(intents.rows[0].n).toBe(0);
  });

  it('pauses a schedule whose creator was downgraded, and produces no run', async () => {
    const schedule = await createSchedule(ctx(A, adminA2, 'admin'), { kind: 'agent_performance', cadence: 'weekly', recipients: [ownerA] });
    await q("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [A, adminA2]);
    await makeDue(schedule.id);
    expect(await runReportSchedules(A)).toContainEqual({ id: schedule.id, outcome: 'paused' });
    const row = (await q('SELECT paused_at IS NOT NULL AS paused, pause_reason FROM report_schedules WHERE id=$1', [schedule.id])).rows[0];
    expect(row).toEqual({ paused: true, pause_reason: 'creator_lost_access' });
    expect((await q('SELECT count(*)::int AS n FROM report_runs WHERE schedule_id=$1', [schedule.id])).rows[0].n).toBe(0);
    // An admin cannot resume it while the creator still lacks access.
    await expect(updateSchedule(owner, schedule.id, { paused: false })).rejects.toMatchObject({ code: 'creator_lost_access' });
  });
});
