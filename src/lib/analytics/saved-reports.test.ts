import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; values: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as { sql: string; values: unknown[] }[],
  respond: (() => []) as (sql: string, values: unknown[]) => unknown,
  contexts: [] as unknown[],
}));

function render(args: unknown[]): Call {
  const [first, ...rest] = args as [unknown, ...unknown[]];
  if (Array.isArray(first) && 'raw' in (first as object)) return { sql: (first as string[]).join('?'), values: rest };
  const sql = first as { sql: string; values: unknown[] };
  return { sql: sql.sql, values: sql.values };
}
const tx = {
  $queryRaw: async (...args: unknown[]) => { const c = render(args); h.calls.push(c); return h.respond(c.sql, c.values); },
  $executeRaw: async (...args: unknown[]) => { const c = render(args); h.calls.push(c); const r = h.respond(c.sql, c.values); return typeof r === 'number' ? r : 1; },
};
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (ctx: unknown, op: (t: typeof tx) => unknown) => { h.contexts.push(ctx); return op(tx); } }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => tx, getPrisma: () => tx }));

import { ScheduleError } from './report-schedules';
import {
  createSavedReport, deleteSavedReport, duplicateSavedReport, exportSavedReport, listSavedReports, previewSavedReport, removeSavedReportSchedule,
  SavedReportError, setSavedReportSchedule, updateSavedReport,
} from './saved-reports';

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const R = '44444444-4444-4444-8444-444444444444';
const admin = { accountId: A, userId: U, role: 'admin' as const };
const agent = { accountId: A, userId: U, role: 'agent' as const };
const body = { name: 'Weekly', metrics: ['new', 'first_response'], group: 'channel', channel: 'all', preset: '7d', format: 'csv' };
const row = {
  id: R, name: 'Weekly', metrics: ['new', 'first_response'], group_by: 'channel', channel: 'all', range_preset: '7d', from_day: null, to_day: null,
  format: 'csv', created_by: U, creator_name: 'Asha', created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-02T00:00:00Z'),
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof SavedReportError || e instanceof ScheduleError ? e.code : String(e)));
const find = (part: string) => h.calls.filter((c) => c.sql.includes(part));

/** A default database: one report, no schedule, UTC workspace, empty metrics. */
function database(overrides: (sql: string, values: unknown[]) => unknown = () => undefined) {
  h.respond = (sql, values) => {
    const o = overrides(sql, values);
    if (o !== undefined) return o;
    if (sql.includes('workspace_inbox_settings')) return [{ timezone: 'UTC' }];
    if (sql.includes('count(*)::int AS n')) return [{ n: 0 }];
    if (sql.includes('lower(name)=lower(')) return [];
    if (sql.includes('INSERT INTO analytics_saved_reports')) return [{ id: R }];
    if (sql.includes('INSERT INTO report_schedules')) return [{ id: 'S1' }];
    if (sql.includes('FROM analytics_saved_reports r')) return [row];
    if (sql.includes('SELECT name FROM analytics_saved_reports')) return [{ name: 'Weekly' }];
    if (sql.includes('FROM report_schedules s')) return [];
    if (sql.includes('AS rows')) return [{ rows: [{ key: 'whatsapp', newC: 4, closed: 1, resolved: 2, frtMedian: 60, frtP90: 90, frtCount: 3, resMedian: null, msgs: 9, failed: 1, handled: 2 }] }];
    return [];
  };
}

beforeEach(() => {
  h.calls = [];
  h.contexts = [];
  database();
});

describe('saved report definitions', () => {
  it('is for admins and owners only, and validates before touching the database', async () => {
    expect(await code(listSavedReports(agent))).toBe('not_found');
    expect(await code(createSavedReport(agent, body))).toBe('not_found');
    expect(await code(createSavedReport(admin, { ...body, metrics: [] }))).toBe('invalid');
    expect(await code(updateSavedReport(admin, 'nope', body))).toBe('not_found');
    expect(h.calls).toHaveLength(0);
  });

  it('creates under the workspace lock as the caller, and audits', async () => {
    const report = await createSavedReport(admin, body);
    expect(report).toMatchObject({ id: R, name: 'Weekly', group: 'channel', range: { preset: '7d', from: null, to: null }, schedule: null });
    expect(find('pg_advisory_xact_lock')[0].values).toEqual([`saved-reports:${A}`]);
    const insert = find('INSERT INTO analytics_saved_reports')[0];
    expect(insert.values).toEqual(expect.arrayContaining([A, 'Weekly', ['new', 'first_response'], 'channel', 'all', '7d', 'csv', U]));
    expect(find('INSERT INTO audit_logs')[0].values).toEqual(expect.arrayContaining([A, U, 'analytics.saved_report_created', R]));
    expect(h.contexts.every((c) => (c as { accountId: string }).accountId === A)).toBe(true);
  });

  it('refuses a taken name (any case) and the 51st report', async () => {
    database((sql) => (sql.includes('lower(name)=lower(') ? [{ id: 'x' }] : undefined));
    expect(await code(createSavedReport(admin, body))).toBe('duplicate_name');
    database((sql) => (sql.includes('count(*)::int AS n') ? [{ n: 50 }] : undefined));
    expect(await code(createSavedReport(admin, body))).toBe('too_many');
    expect(find('INSERT INTO analytics_saved_reports')).toHaveLength(0);
  });

  it('edits only this workspace\'s report and moves its schedule to the new file type', async () => {
    await updateSavedReport(admin, R, { ...body, format: 'pdf' });
    const update = find('UPDATE analytics_saved_reports')[0];
    expect(update.values).toEqual(expect.arrayContaining([A, R, 'pdf']));
    expect(find('UPDATE report_schedules SET format=')[0].values).toEqual(expect.arrayContaining(['pdf', A, R]));
    database((sql) => (sql.includes('FROM analytics_saved_reports r') ? [] : undefined));
    expect(await code(updateSavedReport(admin, R, body))).toBe('not_found');
  });

  it('duplicates as "<name> copy" without the schedule', async () => {
    await duplicateSavedReport(admin, R);
    expect(find('INSERT INTO analytics_saved_reports')[0].values).toContain('Weekly copy');
    expect(find('INSERT INTO report_schedules')).toHaveLength(0);
  });

  it('deletes (its schedule goes by the foreign key) and reports a missing one', async () => {
    await deleteSavedReport(admin, R);
    expect(find('DELETE FROM analytics_saved_reports')[0].values).toEqual([A, R]);
    database((sql) => (sql.includes('DELETE FROM analytics_saved_reports') ? 0 : undefined));
    expect(await code(deleteSavedReport(admin, R))).toBe('not_found');
  });
});

describe('preview and export', () => {
  it('previews with the workspace timezone and a statement timeout', async () => {
    const preview = await previewSavedReport(admin, R);
    expect(find("set_config('statement_timeout'")).toHaveLength(1);
    expect(preview.range.timezone).toBe('UTC');
    expect(preview.rows).toEqual([
      { key: 'whatsapp', name: null, values: { new: 4, first_response: 60 } },
      { key: 'instagram', name: null, values: { new: 0, first_response: null } },
    ]);
  });

  it('exports a CSV and audits the export in the same transaction', async () => {
    const file = await exportSavedReport(admin, R, 'csv');
    expect(file.format).toBe('csv');
    expect(file.filename).toMatch(/^weekly_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const text = new TextDecoder().decode(file.bytes);
    expect(text).toContain('"channel","new_conversations","median_first_response_seconds"');
    expect(text).toContain('"WhatsApp","4","60"');
    expect(find('INSERT INTO audit_logs')[0].values).toEqual(expect.arrayContaining(['analytics.saved_report_exported', R]));
  });
});

describe('email schedule', () => {
  const schedule = { cadence: 'weekly', hourLocal: 9, minuteLocal: 30, recipients: [U] };

  it('validates timing and recipients first', async () => {
    expect(await code(setSavedReportSchedule(admin, R, { ...schedule, minuteLocal: 60 }))).toBe('invalid');
    expect(await code(setSavedReportSchedule(admin, R, { ...schedule, cadence: 'hourly' }))).toBe('invalid');
    expect(await code(setSavedReportSchedule(admin, R, { ...schedule, recipients: [] }))).toBe('invalid_recipients');
    expect(h.calls).toHaveLength(0);
  });

  it('creates one saved_report schedule with the minute, for current admin recipients only', async () => {
    database((sql) => (sql.includes('FROM account_memberships') ? [{ user_id: U }] : undefined));
    await setSavedReportSchedule(admin, R, schedule);
    expect(find('pg_advisory_xact_lock')[0].values).toEqual([`report-schedules:${A}`]);
    const insert = find('INSERT INTO report_schedules')[0];
    expect(insert.values).toEqual(expect.arrayContaining([A, 'saved_report', 'csv', 'weekly', 9, 30, R, [U], U]));
    database((sql) => (sql.includes('FROM account_memberships') ? [] : undefined));
    expect(await code(setSavedReportSchedule(admin, R, schedule))).toBe('invalid_recipients');
  });

  it('updates the existing schedule instead of adding one, and keeps the workspace limit for new ones', async () => {
    database((sql) => (sql.includes('FROM account_memberships') ? [{ user_id: U }]
      : sql.includes('saved_report_id=') && sql.includes('FOR UPDATE') ? [{ id: 'S1' }] : undefined));
    await setSavedReportSchedule(admin, R, schedule);
    expect(find('INSERT INTO report_schedules')).toHaveLength(0);
    expect(find('UPDATE report_schedules SET cadence=')).toHaveLength(1);
    database((sql) => (sql.includes('FROM account_memberships') ? [{ user_id: U }] : sql.includes('count(*)::int AS n') ? [{ n: 10 }] : undefined));
    expect(await code(setSavedReportSchedule(admin, R, schedule))).toBe('too_many');
  });

  it('stops sending by deleting the schedule, and says when there is none', async () => {
    database((sql) => (sql.includes('DELETE FROM report_schedules') ? [{ id: 'S1' }] : undefined));
    await removeSavedReportSchedule(admin, R);
    expect(find('DELETE FROM report_schedules')[0].values).toEqual([A, R]);
    database();
    expect(await code(removeSavedReportSchedule(admin, R))).toBe('not_found');
  });
});
