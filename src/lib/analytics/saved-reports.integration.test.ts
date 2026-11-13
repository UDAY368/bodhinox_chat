// Saved analytics reports and the redesign's grouped metrics on PostgreSQL:
// - An admin saves, edits, duplicates, previews, exports, schedules and deletes
//   reports; names are unique per workspace ignoring case.
// - Agents and viewers can neither read nor write them (row-level security),
//   and another workspace never sees, previews, exports or changes them.
// - Deleting a report deletes its email schedule (foreign key cascade), and a
//   due schedule queues a run with the definition snapshotted in its params.
// - The grouped metrics and team figures count only this workspace's rows.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { groupedMetrics, teamStats, trendReport } from './insights';
import { parseRange } from './range';
import { runReportSchedules } from './report-schedules';
import {
  createSavedReport, deleteSavedReport, duplicateSavedReport, exportSavedReport, listSavedReports, previewSavedReport,
  removeSavedReportSchedule, SavedReportError, setSavedReportSchedule, updateSavedReport,
} from './saved-reports';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID();
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const admin = { accountId: A, userId: ownerA, role: 'owner' as const };
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const other = { accountId: B, userId: ownerB, role: 'owner' as const };
const report = (name: string) => ({ name, metrics: ['new', 'resolved', 'messages'], group: 'channel', channel: 'all', preset: '7d', format: 'csv' });
const code = async (work: Promise<unknown>) => work.then(() => 'ok', (e) => (e instanceof SavedReportError ? e.code : e?.code ?? 'error'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('saved analytics reports', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Reports','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reports A',$2),($3,'Reports B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
    // One conversation per workspace today, with an agent reply; B's must never count for A.
    for (const [account, user, contact] of [[A, ownerA, contactA], [B, ownerB, contactB]]) {
      await q("INSERT INTO contacts(id,account_id,user_id,phone,name) VALUES($1,$2,$3,$4,'Customer')", [contact, account, user, `1415${Math.floor(1e6 + Math.random() * 8e6)}`]);
      const conv = (await q("INSERT INTO conversations(account_id,user_id,contact_id,assigned_agent_id,created_at) VALUES($1,$2,$3,$2,now() - interval '1 hour') RETURNING id",
        [account, user, contact])).rows[0].id;
      await q("INSERT INTO messages(account_id,conversation_id,sender_type,content_text,created_at) VALUES($1,$2,'customer','hi',now() - interval '50 minutes')", [account, conv]);
      await q("INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_text,created_at) VALUES($1,$2,'agent',$3,'hello',now() - interval '40 minutes')", [account, conv, user]);
    }
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('an admin saves, edits and duplicates reports; names are unique ignoring case', async () => {
    const saved = await createSavedReport(admin, report('Weekly support'));
    expect(await code(createSavedReport(admin, report('WEEKLY SUPPORT')))).toBe('duplicate_name');
    const edited = await updateSavedReport(admin, saved.id, { ...report('Weekly support'), group: 'agent', format: 'pdf' });
    expect(edited).toMatchObject({ group: 'agent', format: 'pdf' });
    const copy = await duplicateSavedReport(admin, saved.id);
    expect(copy.name).toBe('Weekly support copy');
    expect((await listSavedReports(admin)).map((r) => r.name).sort()).toEqual(['Weekly support', 'Weekly support copy']);
  });

  it('is invisible to agents, viewers (RLS) and other workspaces', async () => {
    const [mine] = await listSavedReports(admin);
    expect(await code(listSavedReports(agent))).toBe('not_found');
    // Even straight through row-level security, an agent's transaction sees no row and cannot insert one.
    expect(await withTenant(agent, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM analytics_saved_reports`)).toEqual([]);
    await expect(withTenant(agent, (tx) => tx.$executeRaw`INSERT INTO analytics_saved_reports(account_id,name,metrics,group_by,range_preset)
      VALUES(${A}::uuid,'sneaky',ARRAY['new'],'day','7d')`)).rejects.toThrow();
    expect(await listSavedReports(other)).toEqual([]);
    expect(await code(previewSavedReport(other, mine.id))).toBe('not_found');
    expect(await code(exportSavedReport(other, mine.id))).toBe('not_found');
    expect(await code(updateSavedReport(other, mine.id, report('Taken')))).toBe('not_found');
    expect(await code(deleteSavedReport(other, mine.id))).toBe('not_found');
    expect(await code(setSavedReportSchedule(other, mine.id, { cadence: 'daily', hourLocal: 8, minuteLocal: 0, recipients: [ownerB] }))).toBe('not_found');
  });

  it('previews and exports only this workspace\'s figures', async () => {
    const saved = await createSavedReport(admin, report('By channel'));
    const preview = await previewSavedReport(admin, saved.id);
    expect(preview.rows.find((r) => r.key === 'whatsapp')?.values).toMatchObject({ new: 1, messages: 1 });
    const file = await exportSavedReport(admin, saved.id, 'csv');
    expect(new TextDecoder().decode(file.bytes)).toContain('"WhatsApp","1","0","1"');
    const audits = await q("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='analytics.saved_report_exported'", [A]);
    expect(audits.rows[0].n).toBe(1);
  });

  it('schedules to the minute for admins only, queues a snapshotted run, and stops with the report', async () => {
    const saved = await createSavedReport(admin, report('Emailed'));
    expect(await code(setSavedReportSchedule(admin, saved.id, { cadence: 'daily', hourLocal: 8, minuteLocal: 45, recipients: [agentA] })))
      .toBe('invalid_recipients');
    const scheduled = await setSavedReportSchedule(admin, saved.id, { cadence: 'daily', hourLocal: 8, minuteLocal: 45, recipients: [ownerA] });
    expect(scheduled.schedule).toMatchObject({ kind: 'saved_report', hourLocal: 8, minuteLocal: 45, savedReport: { id: saved.id, name: 'Emailed' } });
    // Make it due and let the worker queue it.
    await q("UPDATE report_schedules SET next_run_at=now() - interval '1 minute' WHERE account_id=$1 AND saved_report_id=$2", [A, saved.id]);
    const results = await runReportSchedules(A);
    expect(results.some((r) => r.outcome === 'queued')).toBe(true);
    const run = await q("SELECT kind, params FROM report_runs WHERE account_id=$1 AND kind='saved_report' ORDER BY created_at DESC LIMIT 1", [A]);
    expect(run.rows[0].params.report).toEqual({ name: 'Emailed', metrics: ['new', 'resolved', 'messages'], group: 'channel', channel: 'all' });

    await removeSavedReportSchedule(admin, saved.id);
    expect(await code(removeSavedReportSchedule(admin, saved.id))).toBe('not_found');
    await setSavedReportSchedule(admin, saved.id, { cadence: 'weekly', hourLocal: 9, minuteLocal: 0, recipients: [ownerA] });
    await deleteSavedReport(admin, saved.id);
    const left = await q('SELECT count(*)::int AS n FROM report_schedules WHERE account_id=$1 AND saved_report_id=$2', [A, saved.id]);
    expect(left.rows[0].n).toBe(0);
  });

  it('grouped metrics, trends and team figures count only this workspace', async () => {
    const range = parseRange({ preset: 'today' }, 'UTC');
    const [byChannel, trend, team] = await withTenant(admin, async (tx) => [
      await groupedMetrics(tx, A, range, 'channel'),
      await trendReport(tx, A, range),
      await teamStats(tx, A, range),
    ] as const);
    expect(byChannel.find((r) => r.key === 'whatsapp')).toMatchObject({ newC: 1, msgs: 1 });
    expect(trend.totals.newC).toBe(1);
    expect(trend.hours.reduce((a, b) => a + b, 0)).toBe(1);
    expect(team.map((m) => m.userId).sort()).toEqual([ownerA, agentA, viewerA].sort());
    expect(team.find((m) => m.userId === ownerA)).toMatchObject({ msgs: 1, handled: 1 });
    // A's transaction naming B's account finds nothing (RLS).
    const leaked = await withTenant(admin, (tx) => groupedMetrics(tx, B, range, 'channel'));
    expect(leaked).toEqual([]);
  });
});
