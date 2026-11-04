import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => ({ puts: new Map<string, Uint8Array>(), deletes: [] as string[] }));
vi.mock('./report-storage', async (original) => ({
  ...(await original<typeof import('./report-storage')>()),
  putReportFile: async (_a: string, key: string, body: Uint8Array) => { files.puts.set(key, body); },
  deleteReportFile: async (_a: string, key: string) => { files.deletes.push(key); },
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { parseRange } from './range';
import {
  agentDayRows, campaignDailyRows, campaignSummaryRows, listReports, MAX_PENDING_REPORTS, memberCampaignRows,
  openReportDownload, requestReport, runReportJob, runReportSweep,
} from './reports';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const owner = randomUUID(), agentX = randomUUID(), viewer = randomUUID(), ownerB = randomUUID();
const [c1, c2, c3, cb] = Array.from({ length: 4 }, () => randomUUID());
const [v1, v2, v3, vb] = Array.from({ length: 4 }, () => randomUUID());
const [b0, b1, b2, bB] = Array.from({ length: 4 }, () => randomUUID());
const ownerCtx = { accountId: A, userId: owner, role: 'owner' as const };
const agentCtx = { accountId: A, userId: agentX, role: 'agent' as const };
const viewerCtx: TenantContext = { accountId: A, userId: viewer, role: 'viewer' };
const ownerBCtx = { accountId: B, userId: ownerB, role: 'owner' as const };
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'UTC', new Date('2026-11-03T00:00:00Z'));
const custom = { preset: 'custom', from: '2026-10-01', to: '2026-10-07' };
let db: pg.Client;

const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const msg = (account: string, conversation: string, sender: string, at: string, extra: Record<string, unknown> = {}) =>
  q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at,sender_id,ai_generated)
     VALUES($1,$2,$3,$4,'secret body',$5,$6,$7,$8)`,
  [account, conversation, sender, extra.contentType ?? 'text', extra.status ?? 'delivered', at, extra.senderId ?? null, extra.ai ?? false]);
const asApp = <T>(ctx: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, op);
const asWorker = <T>(ctx: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, op, getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('analytics CSV reports on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Reports', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[owner, agentX, viewer, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reports A',$2),($3,'Reports B',$4)", [A, owner, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, owner, agentX, viewer, B, ownerB]);
    await q(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES
      ($1,'Olu','olu@example.invalid',$4,'owner'),($2,'Xia','xia@example.invalid',$4,'agent'),($3,'Vee','vee@example.invalid',$4,'viewer')
      ON CONFLICT (user_id) DO UPDATE SET full_name=EXCLUDED.full_name`, [owner, agentX, viewer, A]);
    await q(`INSERT INTO contacts(id,account_id,user_id,name,phone) SELECT id, $1, $2, 'Secret Name', '9199' || lpad(n::text, 8, '0')
      FROM unnest($3::uuid[]) WITH ORDINALITY t(id, n)`, [A, owner, [c1, c2, c3]]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'B','14155550198')", [cb, B, ownerB]);
    const conv = (id: string, account: string, user: string, contact: string, agent: string | null, status = 'open') =>
      q(`INSERT INTO conversations(id,account_id,user_id,contact_id,created_at,last_message_at,assigned_agent_id,status)
         VALUES($1,$2,$3,$4,'2026-10-02T09:00:00Z','2026-10-02T09:00:00Z',$5,$6)`, [id, account, user, contact, agent, status]);
    await conv(v1, A, owner, c1, agentX);
    await conv(v2, A, owner, c2, agentX, 'closed');
    await conv(v3, A, owner, c3, null);
    await conv(vb, B, ownerB, cb, ownerB, 'closed');
    await q("UPDATE conversations SET resolved_at='2026-10-03T11:00:00Z' WHERE id = ANY($1::uuid[])", [[v2, vb]]);

    // v1: first wait 10:00 -> agent reply 10:05 (300 s); a campaign reply on 10-04 answered by the assignee.
    await msg(A, v1, 'customer', '2026-10-02T10:00:00Z');
    await msg(A, v1, 'customer', '2026-10-02T10:01:00Z');
    await msg(A, v1, 'agent', '2026-10-02T10:05:00Z', { senderId: agentX });
    await msg(A, v1, 'customer', '2026-10-04T08:00:00Z');
    await msg(A, v1, 'agent', '2026-10-04T08:10:00Z');
    await msg(A, v1, 'agent', '2026-10-06T08:10:00Z', { status: 'failed' });
    // v2: the first wait is answered by the bot, the second by the agent.
    await msg(A, v2, 'customer', '2026-10-03T09:00:00Z');
    await msg(A, v2, 'bot', '2026-10-03T09:01:00Z', { ai: true });
    await msg(A, v2, 'customer', '2026-10-03T09:30:00Z');
    await msg(A, v2, 'agent', '2026-10-03T10:30:00Z', { senderId: agentX });
    await msg(A, v2, 'agent', '2026-10-03T10:31:00Z', { contentType: 'template' });
    // v3: never answered, unassigned.
    await msg(A, v3, 'customer', '2026-10-02T12:00:00Z');
    await msg(B, vb, 'customer', '2026-10-02T10:00:00Z');
    await msg(B, vb, 'agent', '2026-10-02T10:00:30Z', { senderId: ownerB });

    await q(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status,scheduled_at,created_at) VALUES
      ($1,$5,$6,'Old','promo','sent','2026-09-01T07:00:00Z','2026-09-01T06:00:00Z'),
      ($2,$5,$6,'October','promo','sent','2026-10-04T07:00:00Z','2026-10-03T06:00:00Z'),
      ($3,$5,$7,'=Second','offer','sent',NULL,'2026-10-05T06:00:00Z'),
      ($4,$8,$9,'B launch','promo','sent','2026-10-04T07:00:00Z','2026-10-04T06:00:00Z')`, [b0, b1, b2, bB, A, owner, agentX, B, ownerB]);
    await q(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at,delivered_at,read_at,clicked_at,created_at) VALUES
      ($1,$2,$4,'read','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z','2026-10-04T07:02:00Z',NULL,'2026-10-04T06:59:00Z'),
      ($1,$2,$5,'delivered','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z',NULL,'2026-10-04T07:30:00Z','2026-10-04T06:59:00Z'),
      ($1,$2,$6,'failed',NULL,NULL,NULL,NULL,'2026-10-04T06:59:00Z'),
      ($1,$3,$6,'sent','2026-10-05T08:00:00Z',NULL,NULL,NULL,'2026-10-05T06:00:00Z'),
      ($1,$7,$4,'delivered','2026-09-01T07:00:00Z','2026-09-01T07:01:00Z',NULL,NULL,'2026-09-01T07:00:00Z'),
      ($8,$9,$10,'read','2026-10-04T07:00:00Z','2026-10-04T07:01:00Z','2026-10-04T07:02:00Z','2026-10-04T07:03:00Z','2026-10-04T07:00:00Z')`,
    [A, b1, b2, c1, c2, c3, b0, B, bB, cb]);
  });

  afterAll(async () => {
    if (db) {
      await q('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[A, B]]);
      await q("DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])", [[A, B]]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, agentX, viewer, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('builds the campaign day-wise funnel per campaign and day', async () => {
    const rows = await asApp(ownerCtx, (tx) => campaignDailyRows(tx, A, range));
    expect(rows).toEqual([
      { day: '2026-10-04', campaignId: b1, campaign: 'October', template: 'promo', recipients: 3, sent: 2, delivered: 2, read: 1, replied: 1, clicked: 1, failed: 1 },
      { day: '2026-10-05', campaignId: b2, campaign: '=Second', template: 'offer', recipients: 1, sent: 1, delivered: 0, read: 0, replied: 0, clicked: 0, failed: 0 },
    ]);
  });

  it('summarises campaigns and attributes them to the members who created them', async () => {
    const summary = await asApp(ownerCtx, (tx) => campaignSummaryRows(tx, A, range));
    expect(summary.map((r) => [r.campaign, r.createdBy, r.createdAt, r.scheduledAt, r.recipients, r.replied])).toEqual([
      ['October', 'Olu', '2026-10-03 06:00', '2026-10-04 07:00', 3, 1],
      ['=Second', 'Xia', '2026-10-05 06:00', null, 1, 0],
    ]);
    const members = await asApp(ownerCtx, (tx) => memberCampaignRows(tx, A, range));
    expect(members.map((r) => [r.name, r.role, r.campaigns, r.recipients, r.sent, r.clicked])).toEqual([
      ['Olu', 'owner', 1, 3, 2, 1], ['Xia', 'agent', 1, 1, 1, 0], ['Vee', 'viewer', 0, 0, 0, 0],
    ]);
  });

  it('reports agent activity per day, attributing unstamped replies to the assignee', async () => {
    const rows = await asApp(ownerCtx, (tx) => agentDayRows(tx, A, range));
    const base = { userId: agentX, name: 'Xia', role: 'agent', conversationsHandled: 1, repliesSent: 1 };
    expect(rows).toEqual([
      { ...base, day: '2026-10-02', firstResponses: 1, medianFirstResponseSeconds: 300, resolved: 0 },
      { ...base, day: '2026-10-03', firstResponses: 0, medianFirstResponseSeconds: null, resolved: 1 },
      { ...base, day: '2026-10-04', firstResponses: 0, medianFirstResponseSeconds: null, resolved: 0 },
    ]);
  });

  it('queues a request with its job and audit entry, builds it, and audits the download', async () => {
    const run = await requestReport(ownerCtx, { kind: 'campaign_daily', range: custom, email: false });
    expect(run).toMatchObject({ kind: 'campaign_daily', status: 'queued', params: { from: '2026-10-01', to: '2026-10-07', timezone: 'UTC' },
      requestedBy: { userId: owner, name: 'Olu' } });
    const job = await q('SELECT type, payload FROM jobs WHERE dedupe_key=$1', [`analytics-report:${run.id}`]);
    expect(job.rows).toEqual([{ type: 'analytics.report', payload: { reportId: run.id } }]);

    await runReportJob(A, { reportId: run.id });
    const key = `${A}/reports/${run.id}.csv`;
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.puts.get(key));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"2026-10-05","${b2}","'=Second","offer","1","1","0","0","0","0","0"`);
    expect(csv).not.toMatch(/9199|Secret|secret body/);
    const [ready] = await listReports(ownerCtx);
    expect(ready).toMatchObject({ id: run.id, status: 'ready', rowCount: 2, truncated: false });

    // A second run of the job (a retried delivery) changes nothing.
    await runReportJob(A, { reportId: run.id });
    expect(files.puts.size).toBe(1);

    expect(await openReportDownload(ownerCtx, run.id)).toEqual({ objectKey: key, filename: 'campaign_daily_2026-10-01_2026-10-07.csv', format: 'csv' });
    const audits = await q('SELECT action FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at, action', [A, run.id]);
    expect(audits.rows.map((r) => r.action).sort()).toEqual(['analytics.report_downloaded', 'analytics.report_requested']);
  });

  it('keeps reports to admins of the workspace, and writes to the worker', async () => {
    await expect(requestReport(agentCtx, { kind: 'agent_performance', range: custom })).rejects.toMatchObject({ code: 'not_found' });
    await expect(asApp(agentCtx, (tx) => tx.$executeRaw`INSERT INTO report_runs(account_id,kind,requested_by)
      VALUES(${A}::uuid,'agent_performance',${agentX}::uuid)`)).rejects.toThrow();
    // An admin cannot insert a finished report or another member's request.
    await expect(asApp(ownerCtx, (tx) => tx.$executeRaw`INSERT INTO report_runs(account_id,kind,requested_by)
      VALUES(${A}::uuid,'agent_performance',${agentX}::uuid)`)).rejects.toThrow();
    await expect(asApp(ownerCtx, (tx) => tx.$executeRaw`UPDATE report_runs SET status='ready' WHERE account_id=${A}::uuid`)).rejects.toThrow();
    await expect(asApp(ownerCtx, (tx) => tx.$executeRaw`DELETE FROM report_runs WHERE account_id=${A}::uuid`)).rejects.toThrow();
    expect(await asApp(viewerCtx, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM report_runs`)).toEqual([]);
    expect(await asApp(agentCtx, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM report_runs`)).toEqual([]);

    const [mine] = await listReports(ownerCtx);
    expect(await listReports(ownerBCtx)).toEqual([]);
    await expect(openReportDownload(ownerBCtx, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    // The worker scoped to B cannot touch A's report.
    expect(await asWorker({ accountId: B, role: 'owner' }, (tx) => tx.$executeRaw`UPDATE report_runs SET status='failed' WHERE id=${mine.id}::uuid`)).toBe(0);
  });

  it('caps queued reports per workspace', async () => {
    for (let i = 0; i < MAX_PENDING_REPORTS; i++) await requestReport(ownerCtx, { kind: 'member_campaigns', range: custom });
    await expect(requestReport(ownerCtx, { kind: 'member_campaigns', range: custom })).rejects.toMatchObject({ code: 'too_many_pending' });
    await expect(openReportDownload(ownerCtx, (await listReports(ownerCtx))[0].id)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('sweeps stuck requests and expired files', async () => {
    const reports = await listReports(ownerCtx);
    const ready = reports.find((r) => r.status === 'ready')!;
    const stuck = reports.find((r) => r.status === 'queued')!;
    await q("UPDATE report_runs SET expires_at=now() - interval '1 minute' WHERE id=$1", [ready.id]);
    await q("UPDATE report_runs SET created_at=now() - interval '7 hours' WHERE id=$1", [stuck.id]);
    const due = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT * FROM crm_accounts_with_due_reports()`;
    expect(due.map((r) => r.account_id)).toContain(A);
    expect(due.map((r) => r.account_id)).not.toContain(B);

    expect(await runReportSweep(A)).toEqual({ failed: 1, expired: 1 });
    expect(files.deletes).toEqual([`${A}/reports/${ready.id}.csv`]);
    const after = await listReports(ownerCtx);
    expect(after.find((r) => r.id === ready.id)).toMatchObject({ status: 'expired' });
    expect(after.find((r) => r.id === stuck.id)).toMatchObject({ status: 'failed', error: 'timed_out' });
    const row = await q('SELECT object_key FROM report_runs WHERE id=$1', [ready.id]);
    expect(row.rows[0].object_key).toBeNull();
    await expect(openReportDownload(ownerCtx, ready.id)).rejects.toMatchObject({ code: 'not_ready' });
    // A job for an expired report does nothing.
    await runReportJob(A, { reportId: ready.id });
    expect(files.puts.size).toBe(1);
  });
});
