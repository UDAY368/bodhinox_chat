import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; values: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as { sql: string; values: unknown[] }[],
  respond: (() => []) as (sql: string, values: unknown[]) => unknown,
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

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, op: (t: typeof tx) => unknown) => op(tx) }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => tx, getPrisma: () => tx }));

import {
  createSchedule, deleteSchedule, localHourInstant, MAX_REPORT_SCHEDULES, nextRunAt, resetReportScheduleDiscoveryForTests,
  runReportSchedules, scheduleReportSchedules, updateSchedule,
} from './report-schedules';

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const owner = { accountId: A, userId: U, role: 'owner' as const };

beforeEach(() => {
  h.calls = [];
  h.respond = () => [];
  resetReportScheduleDiscoveryForTests();
});

describe('timing (workspace timezone, DST-safe)', () => {
  it('finds the local hour across the New York DST changes', () => {
    expect(localHourInstant('2026-03-08', 8, 'America/New_York').toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(localHourInstant('2026-03-07', 8, 'America/New_York').toISOString()).toBe('2026-03-07T13:00:00.000Z');
    expect(localHourInstant('2026-11-01', 8, 'America/New_York').toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(localHourInstant('2026-10-31', 8, 'America/New_York').toISOString()).toBe('2026-10-31T12:00:00.000Z');
    expect(localHourInstant('2026-11-04', 0, 'Asia/Kolkata').toISOString()).toBe('2026-11-03T18:30:00.000Z');
  });

  it('daily: later today, else tomorrow', () => {
    const tz = 'Asia/Kolkata';
    expect(nextRunAt('daily', 8, tz, new Date('2026-11-04T01:00:00Z')).toISOString()).toBe('2026-11-04T02:30:00.000Z');
    expect(nextRunAt('daily', 8, tz, new Date('2026-11-04T02:30:00Z')).toISOString()).toBe('2026-11-05T02:30:00.000Z');
  });

  it('weekly on Monday and monthly on the 1st', () => {
    // 2026-11-04 is a Wednesday.
    expect(nextRunAt('weekly', 8, 'UTC', new Date('2026-11-04T10:00:00Z')).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(nextRunAt('weekly', 8, 'UTC', new Date('2026-11-09T07:59:00Z')).toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(nextRunAt('monthly', 6, 'UTC', new Date('2026-11-04T10:00:00Z')).toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(nextRunAt('monthly', 6, 'UTC', new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T06:00:00.000Z');
    // The first Monday after the March change keeps 08:00 local.
    expect(nextRunAt('weekly', 8, 'America/New_York', new Date('2026-03-04T00:00:00Z')).toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });
});

describe('admin routes library', () => {
  it('refuses members below admin and invalid input before touching the database', async () => {
    await expect(createSchedule({ ...owner, role: 'agent' }, { kind: 'campaign_summary', cadence: 'weekly', recipients: [U] }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(createSchedule(owner, { kind: 'messages', cadence: 'weekly', recipients: [U] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'hourly', recipients: [U] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', hourLocal: 24, recipients: [U] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: [] })).rejects.toMatchObject({ code: 'invalid_recipients' });
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: [U, U] })).rejects.toMatchObject({ code: 'invalid_recipients' });
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'daily', recipients: Array(11).fill(U) }))
      .rejects.toMatchObject({ code: 'invalid_recipients' });
    await expect(updateSchedule(owner, 'nope', { paused: true })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteSchedule(owner, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(h.calls).toEqual([]);
  });

  it('counts under the workspace lock and refuses the eleventh schedule', async () => {
    h.respond = (sql) => (sql.includes('count(*)') ? [{ n: MAX_REPORT_SCHEDULES }] : []);
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'weekly', recipients: [U] }))
      .rejects.toMatchObject({ code: 'too_many', status: 409 });
    expect(h.calls[0].sql).toContain('pg_advisory_xact_lock');
    expect(h.calls[0].values).toContain(`report-schedules:${A}`);
    expect(h.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('refuses recipients who are not current admins or owners', async () => {
    h.respond = (sql) => (sql.includes('count(*)') ? [{ n: 0 }] : sql.includes("role IN ('owner','admin')") ? [{ user_id: U }] : []);
    await expect(createSchedule(owner, { kind: 'campaign_summary', cadence: 'weekly', recipients: [U, V] }))
      .rejects.toMatchObject({ code: 'invalid_recipients', status: 400 });
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO report_schedules'))).toBe(false);
  });

  it('creates as the caller with the next local occurrence, and audits', async () => {
    const created = new Date('2026-11-04T00:00:00Z');
    h.respond = (sql) => {
      if (sql.includes('count(*)')) return [{ n: 1 }];
      if (sql.includes("role IN ('owner','admin')")) return [{ user_id: U }];
      if (sql.includes('workspace_inbox_settings')) return [{ timezone: 'UTC' }];
      if (sql.includes('INSERT INTO report_schedules')) return [{ id: S }];
      if (sql.includes('FROM report_schedules s')) return [{ id: S, kind: 'commerce_daily', format: 'pdf', cadence: 'daily', hour_local: 7,
        recipients: [U], created_by: U, paused_at: null, pause_reason: null, next_run_at: created, last_run_id: null, created_at: created }];
      if (sql.includes('FROM profiles')) return [{ user_id: U, full_name: 'Olu' }];
      return [];
    };
    const schedule = await createSchedule(owner, { kind: 'commerce_daily', format: 'pdf', cadence: 'daily', hourLocal: 7, recipients: [U] });
    expect(schedule).toMatchObject({ id: S, kind: 'commerce_daily', format: 'pdf', recipients: [{ userId: U, name: 'Olu' }], createdBy: { userId: U } });
    const insert = h.calls.find((c) => c.sql.includes('INSERT INTO report_schedules'))!;
    expect(insert.values).toEqual(expect.arrayContaining([A, 'commerce_daily', 'pdf', 'daily', 7, [U], U]));
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))!.values).toContain('analytics.report_schedule_created');
  });

  it('keeps a saved report schedule on the report\'s own file type', async () => {
    const at = new Date('2026-11-04T00:00:00Z');
    const row = { id: S, kind: 'saved_report', format: 'csv', cadence: 'weekly', hour_local: 8, minute_local: 30, saved_report_id: RUN,
      saved_report_name: 'Weekly', recipients: [U], created_by: U, paused_at: null, pause_reason: null, next_run_at: at, last_run_id: null, created_at: at };
    h.respond = (sql) => (sql.includes('FROM report_schedules s') ? [row] : []);
    await expect(updateSchedule(owner, S, { format: 'pdf' })).rejects.toMatchObject({ code: 'format_locked', status: 409 });
    expect(h.calls.some((c) => c.sql.includes('UPDATE report_schedules'))).toBe(false);
    // The same type, or no type, is fine (pause and resume still work).
    await updateSchedule(owner, S, { format: 'csv', paused: true });
    expect(h.calls.some((c) => c.sql.includes('UPDATE report_schedules'))).toBe(true);
  });

  it('pauses and resumes with paused_at and pause_reason together, and keeps a lost-access pause while it is still true', async () => {
    const at = new Date('2026-11-04T00:00:00Z');
    const row = { id: S, kind: 'campaign_summary', format: 'csv', cadence: 'weekly', hour_local: 8, recipients: [U], created_by: V,
      paused_at: null as Date | null, pause_reason: null as string | null, next_run_at: at, last_run_id: null, created_at: at };
    h.respond = (sql) => (sql.includes('FROM report_schedules s') ? [row] : []);
    await updateSchedule(owner, S, { paused: true });
    const pause = h.calls.find((c) => c.sql.includes('UPDATE report_schedules'))!;
    expect(pause.values).toContain('manual');
    expect(pause.values.some((v) => v instanceof Date && v !== at)).toBe(true);

    h.calls = [];
    row.paused_at = at;
    row.pause_reason = 'creator_lost_access';
    h.respond = (sql) => (sql.includes('FROM report_schedules s') ? [row] : sql.includes('FROM account_memberships') ? [{ role: 'agent' }] : []);
    await expect(updateSchedule(owner, S, { paused: false })).rejects.toMatchObject({ code: 'creator_lost_access', status: 409 });
    expect(h.calls.some((c) => c.sql.includes('UPDATE report_schedules'))).toBe(false);

    h.calls = [];
    h.respond = (sql) => (sql.includes('FROM report_schedules s') ? [row] : sql.includes('FROM account_memberships') ? [{ role: 'admin' }]
      : sql.includes('workspace_inbox_settings') ? [{ timezone: 'UTC' }] : []);
    await updateSchedule(owner, S, { paused: false });
    const resume = h.calls.find((c) => c.sql.includes('UPDATE report_schedules'))!;
    // paused_at and pause_reason are cleared together.
    expect(resume.values.filter((v) => v === null)).toHaveLength(2);
  });
});

describe('worker', () => {
  it('discovers due workspaces at most every five minutes', async () => {
    h.respond = (sql) => (sql.includes('crm_accounts_with_due_report_schedules') ? [{ account_id: A }] : []);
    expect(await scheduleReportSchedules(1_000_000)).toBe(1);
    const job = h.calls.find((c) => c.sql.includes('INSERT INTO jobs'))!;
    expect(job.values).toEqual(expect.arrayContaining(['analytics.report_schedules', A, `report-schedules:${A}:3`]));
    expect(await scheduleReportSchedules(1_000_000 + 60_000)).toBe(0);
    expect(await scheduleReportSchedules(1_000_000 + 5 * 60_000)).toBe(1);
  });

  it('pauses a schedule whose creator lost admin access and produces no run', async () => {
    let served = false;
    h.respond = (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (served) return [];
        served = true;
        return [{ id: S, kind: 'campaign_summary', format: 'csv', cadence: 'weekly', hour_local: 8, created_by: V }];
      }
      if (sql.includes('FROM account_memberships')) return [{ role: 'agent' }];
      return [];
    };
    expect(await runReportSchedules(A, new Date('2026-11-09T09:00:00Z'))).toEqual([{ id: S, outcome: 'paused' }]);
    expect(h.calls.find((c) => c.sql.includes("pause_reason='creator_lost_access'"))).toBeDefined();
    expect(h.calls.find((c) => c.sql.includes('analytics.report_schedule_paused'))).toBeDefined();
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO report_runs') || c.sql.includes('INSERT INTO jobs'))).toBe(false);
  });

  it('inserts one run for the previous complete period, queues its build and advances the schedule', async () => {
    let served = false;
    h.respond = (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (served) return [];
        served = true;
        return [{ id: S, kind: 'product_summary', format: 'pdf', cadence: 'weekly', hour_local: 8, created_by: U }];
      }
      if (sql.includes('FROM account_memberships')) return [{ role: 'admin' }];
      if (sql.includes('workspace_inbox_settings')) return [{ timezone: 'UTC' }];
      if (sql.includes('INSERT INTO report_runs')) return [{ id: RUN }];
      return [];
    };
    const now = new Date('2026-11-09T08:00:30Z');
    expect(await runReportSchedules(A, now)).toEqual([{ id: S, outcome: 'queued' }]);
    const run = h.calls.find((c) => c.sql.includes('INSERT INTO report_runs'))!;
    // The period is (from, to), so a cadence change never collides with the old cadence's run.
    expect(run.sql).toContain('ON CONFLICT (account_id, schedule_id, (params->>\'from\'), (params->>\'to\'))');
    expect(run.values).toEqual(expect.arrayContaining([A, 'product_summary', 'pdf', U, S,
      JSON.stringify({ from: '2026-11-02', to: '2026-11-08', timezone: 'UTC' })]));
    const job = h.calls.find((c) => c.sql.includes('INSERT INTO jobs'))!;
    expect(job.values).toEqual(expect.arrayContaining(['analytics.report', JSON.stringify({ reportId: RUN, scheduled: true }), `analytics-report:${RUN}`]));
    const advance = h.calls.find((c) => c.sql.includes('SET next_run_at'))!;
    expect(advance.values[0]).toEqual(new Date('2026-11-16T08:00:00Z'));
  });

  it('runs at a local minute when one is set (saved report schedules)', () => {
    expect(nextRunAt('daily', 9, 'Asia/Kolkata', new Date('2026-11-04T03:00:00Z'), 45).toISOString()).toBe('2026-11-04T04:15:00.000Z');
    expect(nextRunAt('daily', 9, 'Asia/Kolkata', new Date('2026-11-04T04:15:00Z'), 45).toISOString()).toBe('2026-11-05T04:15:00.000Z');
  });

  it('snapshots a saved report definition into its scheduled run and advances to the same minute', async () => {
    let served = false;
    const SAVED = '66666666-6666-4666-8666-666666666666';
    h.respond = (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (served) return [];
        served = true;
        return [{ id: S, kind: 'saved_report', format: 'csv', cadence: 'daily', hour_local: 9, minute_local: 30, saved_report_id: SAVED, created_by: U }];
      }
      if (sql.includes('FROM account_memberships')) return [{ role: 'admin' }];
      if (sql.includes('workspace_inbox_settings')) return [{ timezone: 'UTC' }];
      if (sql.includes('FROM analytics_saved_reports')) return [{ name: 'Weekly support', metrics: ['resolved', 'new'], group_by: 'agent', channel: 'whatsapp' }];
      if (sql.includes('INSERT INTO report_runs')) return [{ id: RUN }];
      return [];
    };
    expect(await runReportSchedules(A, new Date('2026-11-09T09:30:10Z'))).toEqual([{ id: S, outcome: 'queued' }]);
    const lookup = h.calls.find((c) => c.sql.includes('FROM analytics_saved_reports'))!;
    expect(lookup.values).toEqual([A, SAVED]);
    const run = h.calls.find((c) => c.sql.includes('INSERT INTO report_runs'))!;
    expect(run.values).toEqual(expect.arrayContaining(['saved_report', JSON.stringify({
      from: '2026-11-08', to: '2026-11-08', timezone: 'UTC',
      report: { name: 'Weekly support', metrics: ['new', 'resolved'], group: 'agent', channel: 'whatsapp' },
    })]));
    const advance = h.calls.find((c) => c.sql.includes('SET next_run_at'))!;
    expect(advance.values[0]).toEqual(new Date('2026-11-10T09:30:00Z'));
  });

  it('queues nothing for a saved report schedule whose definition is gone', async () => {
    let served = false;
    h.respond = (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (served) return [];
        served = true;
        return [{ id: S, kind: 'saved_report', format: 'csv', cadence: 'daily', hour_local: 9, minute_local: 0, saved_report_id: S, created_by: U }];
      }
      if (sql.includes('FROM account_memberships')) return [{ role: 'admin' }];
      return [];
    };
    expect(await runReportSchedules(A, new Date('2026-11-09T09:30:10Z'))).toEqual([{ id: S, outcome: 'repeat' }]);
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO report_runs'))).toBe(false);
  });

  it('treats a repeated period as a no-op that still advances', async () => {
    let served = false;
    h.respond = (sql) => {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        if (served) return [];
        served = true;
        return [{ id: S, kind: 'campaign_daily', format: 'csv', cadence: 'daily', hour_local: 8, created_by: U }];
      }
      if (sql.includes('FROM account_memberships')) return [{ role: 'owner' }];
      return [];
    };
    expect(await runReportSchedules(A, new Date('2026-11-04T09:00:00Z'))).toEqual([{ id: S, outcome: 'repeat' }]);
    expect(h.calls.some((c) => c.sql.includes('INSERT INTO jobs'))).toBe(false);
    expect(h.calls.some((c) => c.sql.includes('SET next_run_at'))).toBe(true);
  });
});
