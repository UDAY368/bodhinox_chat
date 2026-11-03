import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { sql: string; values: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as { sql: string; values: unknown[] }[],
  respond: (() => []) as (sql: string, values: unknown[]) => unknown,
  puts: [] as { key: string; bytes: Uint8Array }[],
  deletes: [] as string[],
  putFails: false,
  sent: [] as unknown[],
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
vi.mock('./report-storage', () => ({
  reportObjectKey: (a: string, r: string) => `${a}/reports/${r}.csv`,
  putReportFile: async (_a: string, key: string, bytes: Uint8Array) => {
    if (h.putFails) throw new Error('s3 down');
    h.puts.push({ key, bytes });
  },
  deleteReportFile: async (_a: string, key: string) => { h.deletes.push(key); },
}));
vi.mock('@/lib/jobs/dispatch', () => ({
  UncertainDispatchError: class extends Error {},
  dispatchOnce: async (_a: string, _k: string, send: () => Promise<unknown>) => send(),
}));
vi.mock('@/lib/auth/email', () => ({
  authEmailTransport: () => ({ sendMail: async (m: unknown) => { h.sent.push(m); }, close: () => {} }),
}));

import { parseRange } from './range';
import {
  buildReport, handleReportJob, isReportKind, listReports, MAX_REPORT_ROWS, rate, REPORT_KINDS, ReportError,
  reportFilename, requestReport, runReportSweep, toCsv,
} from './reports';

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const range = parseRange({ from: '2026-10-01', to: '2026-10-07' }, 'Asia/Kolkata', new Date('2026-11-03T00:00:00Z'));
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

beforeEach(() => {
  h.calls = [];
  h.respond = () => [];
  h.puts = [];
  h.deletes = [];
  h.putFails = false;
  h.sent = [];
  delete process.env.SMTP_URL;
  delete process.env.AUTH_EMAIL_FROM;
  delete process.env.APP_URL;
});

describe('CSV', () => {
  it('starts with a BOM, quotes every cell, uses CRLF and neutralises formulas', () => {
    const text = decode(toCsv([{ header: 'name', value: (r: { v: unknown }) => r.v }],
      [{ v: '=HYPERLINK("x")' }, { v: '+1' }, { v: '-2' }, { v: '@a' }, { v: 'Café "A"' }, { v: null }, { v: 7 }]));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split('\r\n')).toEqual([
      '"name"', `"'=HYPERLINK(""x"")"`, `"'+1"`, `"'-2"`, `"'@a"`, '"Café ""A"""', '""', '"7"', '',
    ]);
  });

  it('formats rates with one decimal and leaves an empty base blank', () => {
    expect(rate(1, 3)).toBe('33.3');
    expect(rate(2, 2)).toBe('100.0');
    expect(rate(1, 0)).toBe('');
  });

  it('names files from the kind and validated days only', () => {
    expect(reportFilename('campaign_daily', { from: '2026-10-01', to: '2026-10-07', timezone: 'UTC' })).toBe('campaign_daily_2026-10-01_2026-10-07.csv');
    expect(reportFilename('agent_performance', { from: '"; rm', to: '2026-10-07', timezone: 'UTC' })).toBe('agent_performance_range_2026-10-07.csv');
    expect(REPORT_KINDS.every(isReportKind)).toBe(true);
    expect(isReportKind('messages')).toBe(false);
  });
});

describe('report queries', () => {
  it.each(REPORT_KINDS)('%s is scoped to the workspace and range, capped, and reads no message content', async (kind) => {
    await buildReport(tx as never, A, kind, range);
    const sql = h.calls.map((c) => c.sql).join('\n');
    const values = h.calls.flatMap((c) => c.values);
    expect(values).toContain(A);
    expect(values).toContain(range.from.toISOString());
    expect(values).toContain(range.to.toISOString());
    if (kind !== 'member_campaigns') expect(values).toContain('Asia/Kolkata');
    expect(values).toContain(MAX_REPORT_ROWS + 1);
    expect(sql).toMatch(/account_id=\?::uuid/);
    expect(sql).not.toMatch(/content_text|\.phone|contacts\.name|media_url|caption/);
  });

  it('marks a report truncated past the row cap and keeps exactly the cap', async () => {
    const row = { day: '2026-10-01', userId: U, name: 'Xia', role: 'agent', conversationsHandled: 1, repliesSent: 2,
      firstResponses: 1, medianFirstResponseSeconds: 60, resolved: 0 };
    h.respond = () => Array.from({ length: MAX_REPORT_ROWS + 1 }, () => row);
    const built = await buildReport(tx as never, A, 'agent_performance', range);
    expect(built).toMatchObject({ rowCount: MAX_REPORT_ROWS, truncated: true });
    expect(decode(built.bytes).split('\r\n')).toHaveLength(MAX_REPORT_ROWS + 2);
  });

  it('renders the campaign summary with rates and local times', async () => {
    h.respond = () => [{ campaignId: R, campaign: 'Diwali', template: 'promo', status: 'sent', createdBy: 'Olu',
      createdAt: '2026-10-03 11:30', scheduledAt: null, recipients: 4, sent: 3, delivered: 2, read: 1, replied: 1, clicked: 0, failed: 1 }];
    const built = await buildReport(tx as never, A, 'campaign_summary', range);
    const [header, line] = decode(built.bytes).slice(1).split('\r\n');
    expect(header).toContain('"created_at (Asia/Kolkata)"');
    expect(line).toBe(`"${R}","Diwali","promo","sent","Olu","2026-10-03 11:30","","4","3","2","1","1","0","1","66.7","50.0","50.0","0.0"`);
  });
});

describe('requests', () => {
  it('refuses agents and unknown kinds before touching the database', async () => {
    await expect(requestReport({ accountId: A, userId: U, role: 'agent' }, { kind: 'campaign_daily', range: {} }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(requestReport({ accountId: A, userId: U, role: 'admin' }, { kind: 'messages', range: {} }))
      .rejects.toBeInstanceOf(ReportError);
    await expect(listReports({ accountId: A, userId: U, role: 'viewer' })).rejects.toBeInstanceOf(ReportError);
    expect(h.calls).toEqual([]);
  });

  it('writes the row, its job and an audit entry in one transaction, and caps pending reports', async () => {
    const created = new Date('2026-11-03T05:00:00Z');
    h.respond = (sql) => {
      if (sql.includes('workspace_inbox_settings')) return [{ timezone: 'UTC' }];
      if (sql.includes("status IN ('queued','running')")) return [{ n: 0 }];
      if (sql.includes('INSERT INTO report_runs')) return [{ id: R }];
      if (sql.includes('FROM report_runs r')) return [{ id: R, kind: 'campaign_daily', status: 'queued', params: { from: '2026-10-28', to: '2026-11-03', timezone: 'UTC' },
        requested_by: U, requester_name: 'Olu', email_requested: true, row_count: null, truncated: false, byte_size: null, error: null,
        created_at: created, finished_at: null, expires_at: created }];
      return [];
    };
    const run = await requestReport({ accountId: A, userId: U, role: 'owner' }, { kind: 'campaign_daily', range: { preset: '7d' }, email: true });
    expect(run).toMatchObject({ id: R, status: 'queued', requestedBy: { userId: U, name: 'Olu' } });
    const job = h.calls.find((c) => c.sql.includes('INSERT INTO jobs'))!;
    expect(job.values).toEqual(expect.arrayContaining(['analytics.report', A, JSON.stringify({ reportId: R }), `analytics-report:${R}`]));
    const audit = h.calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))!;
    expect(audit.values).toContain('analytics.report_requested');

    h.calls = [];
    h.respond = (sql) => (sql.includes('workspace_inbox_settings') ? [] : sql.includes("status IN ('queued','running')") ? [{ n: 5 }] : []);
    await expect(requestReport({ accountId: A, userId: U, role: 'owner' }, { kind: 'campaign_daily', range: {} }))
      .rejects.toMatchObject({ code: 'too_many_pending', status: 429 });
    expect(h.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });
});

describe('worker job', () => {
  const claim = (extra: Record<string, unknown> = {}) => (sql: string) => {
    if (sql.includes("SET status='running'")) return [{ kind: 'member_campaigns', params: { from: '2026-10-01', to: '2026-10-07', timezone: 'UTC' },
      email_requested: false, requested_by: U, ...extra }];
    return [];
  };

  it('builds, stores privately and marks the report ready', async () => {
    h.respond = claim();
    await handleReportJob(A, 'analytics.report', { reportId: R }, { attempts: 1, maxAttempts: 3 });
    expect(h.puts.map((p) => p.key)).toEqual([`${A}/reports/${R}.csv`]);
    const ready = h.calls.find((c) => c.sql.includes("SET status='ready'"))!;
    expect(ready.values).toEqual(expect.arrayContaining([`${A}/reports/${R}.csv`, 0, false, A, R]));
  });

  it('does nothing for a report that is no longer queued', async () => {
    await handleReportJob(A, 'analytics.report', { reportId: R });
    expect(h.puts).toEqual([]);
    await expect(handleReportJob(A, 'analytics.report', { reportId: 'nope' })).rejects.toThrow('Invalid report job');
  });

  it('retries a failed build and marks it failed only on the last attempt', async () => {
    h.respond = claim();
    h.putFails = true;
    await expect(handleReportJob(A, 'analytics.report', { reportId: R }, { attempts: 1, maxAttempts: 3 })).rejects.toThrow();
    expect(h.calls.some((c) => c.sql.includes("SET status='failed'"))).toBe(false);
    await expect(handleReportJob(A, 'analytics.report', { reportId: R }, { attempts: 3, maxAttempts: 3 })).rejects.toThrow();
    expect(h.calls.find((c) => c.sql.includes("SET status='failed'"))!.values).toContain('build_failed');
  });

  it('emails an admin requester a sign-in link when SMTP is configured, and skips others', async () => {
    Object.assign(process.env, { SMTP_URL: 'smtp://x', AUTH_EMAIL_FROM: 'reports@bodhinox.test', APP_URL: 'https://app.bodhinox.test' });
    const base = claim({ email_requested: true });
    h.respond = (sql) => (sql.includes('FROM account_memberships m') ? [{ email: 'olu@example.test', role: 'admin' }] : base(sql));
    await handleReportJob(A, 'analytics.report', { reportId: R });
    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0] as { to: string; text: string };
    expect(mail.to).toBe('olu@example.test');
    expect(mail.text).toContain(`https://app.bodhinox.test/api/analytics/reports/${R}/download`);

    h.sent = [];
    h.respond = (sql) => (sql.includes('FROM account_memberships m') ? [{ email: 'olu@example.test', role: 'agent' }] : base(sql));
    await handleReportJob(A, 'analytics.report', { reportId: R });
    expect(h.sent).toEqual([]);
  });

  it('deletes the uploaded file and sends no email when the row left running before the ready update', async () => {
    Object.assign(process.env, { SMTP_URL: 'smtp://x', AUTH_EMAIL_FROM: 'reports@bodhinox.test', APP_URL: 'https://app.bodhinox.test' });
    const base = claim({ email_requested: true });
    let status = 'failed';
    h.respond = (sql) => {
      if (sql.includes("SET status='ready'")) return 0;
      if (sql.includes('SELECT status FROM report_runs')) return [{ status }];
      if (sql.includes('FROM account_memberships m')) return [{ email: 'olu@example.test', role: 'admin' }];
      return base(sql);
    };
    await handleReportJob(A, 'analytics.report', { reportId: R }, { attempts: 1, maxAttempts: 3 });
    expect(h.deletes).toEqual([`${A}/reports/${R}.csv`]);
    expect(h.sent).toEqual([]);
    // A concurrent run already made the same file ready: keep it.
    h.deletes = [];
    status = 'ready';
    await handleReportJob(A, 'analytics.report', { reportId: R }, { attempts: 1, maxAttempts: 3 });
    expect(h.deletes).toEqual([]);
  });

  it('swallows a failed requester lookup for the ready email instead of failing the job', async () => {
    Object.assign(process.env, { SMTP_URL: 'smtp://x', AUTH_EMAIL_FROM: 'reports@bodhinox.test', APP_URL: 'https://app.bodhinox.test' });
    const base = claim({ email_requested: true });
    h.respond = (sql) => {
      if (sql.includes('FROM account_memberships m')) throw new Error('pool timeout');
      return base(sql);
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleReportJob(A, 'analytics.report', { reportId: R })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('[reports] ready email failed', { kind: 'member_campaigns' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('pool timeout');
    log.mockRestore();
  });

  it('sweep fails stuck requests, deletes expired files and marks rows expired', async () => {
    h.respond = (sql) => (sql.includes('SELECT id::text AS id, object_key')
      ? [{ id: R, object_key: `${A}/reports/${R}.csv` }, { id: U, object_key: null }] : []);
    const result = await runReportSweep(A);
    // A row without object_key still has its file deleted by the deterministic key.
    expect(h.deletes).toEqual([`${A}/reports/${R}.csv`, `${A}/reports/${U}.csv`]);
    expect(result).toEqual({ failed: 1, expired: 2 });
    expect(h.calls.find((c) => c.sql.includes("error='timed_out'"))).toBeDefined();
    await expect(handleReportJob(A, 'analytics.other', {})).rejects.toThrow('Unsupported');
  });
});
