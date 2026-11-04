import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { sql: string; values: unknown[] }[],
  respond: (() => []) as (sql: string, values: unknown[]) => unknown,
  contexts: [] as unknown[],
}));

function render(args: unknown[]) {
  const [first, ...rest] = args as [unknown, ...unknown[]];
  if (Array.isArray(first) && 'raw' in (first as object)) return { sql: (first as string[]).join('?'), values: rest };
  const sql = first as { sql: string; values: unknown[] };
  return { sql: sql.sql, values: sql.values };
}
const tx = {
  $queryRaw: async (...args: unknown[]) => { const c = render(args); h.calls.push(c); return h.respond(c.sql, c.values); },
  $executeRaw: async (...args: unknown[]) => { const c = render(args); h.calls.push(c); const r = h.respond(c.sql, c.values); return typeof r === 'number' ? r : 1; },
};
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, op: (t: typeof tx) => unknown) => { h.contexts.push(ctx); return op(tx); },
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => tx, getPrisma: () => tx }));

import { shareRolesFor } from './report-kinds';
import { createShare, listShares, openShare, revokeShare, shareRoleAllowed, sharePath, shareUrl } from './report-shares';

const A = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const admin = { accountId: A, userId: U, role: 'admin' as const };
const at = new Date('2026-11-05T00:00:00Z');
const shareRow = { id: S, report_run_id: R, min_role: 'agent', created_by: U, creator_name: 'Olu', expires_at: at, revoked_at: null,
  open_count: 0, last_opened_at: null, created_at: at };

beforeEach(() => {
  h.calls = [];
  h.respond = () => [];
  h.contexts = [];
  delete process.env.APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe('share role bounds', () => {
  it('never allows a share below the lowest role that sees the data live', () => {
    expect(shareRoleAllowed('campaign_summary', 'viewer')).toBe(true);
    expect(shareRoleAllowed('service_summary', 'viewer')).toBe(true);
    expect(shareRoleAllowed('product_summary', 'viewer')).toBe(false);
    expect(shareRoleAllowed('product_summary', 'agent')).toBe(true);
    expect(shareRoleAllowed('commerce_daily', 'viewer')).toBe(false);
    expect(shareRolesFor('commerce_daily')).toEqual(['agent', 'admin']);
    expect(shareRolesFor('agent_performance')).toEqual(['viewer', 'agent', 'admin']);
  });

  it('builds links from the share id only', () => {
    expect(sharePath(S)).toBe(`/reports/shared/${S}`);
    expect(shareUrl(S)).toBeNull();
    process.env.APP_URL = 'https://app.bodhinox.test';
    expect(shareUrl(S)).toBe(`https://app.bodhinox.test/reports/shared/${S}`);
  });
});

describe('create, list, revoke (admins)', () => {
  it('refuses below admin, bad input and malformed ids before the database', async () => {
    await expect(createShare({ ...admin, role: 'agent' }, R, { minRole: 'viewer', expiresInHours: 24 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createShare(admin, R, { minRole: 'owner', expiresInHours: 24 })).rejects.toMatchObject({ code: 'invalid', status: 400 });
    await expect(createShare(admin, R, { minRole: 'viewer', expiresInHours: 169 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createShare(admin, R, { minRole: 'viewer', expiresInHours: 0 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createShare(admin, R, { minRole: 'viewer', expiresInHours: 1.5 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createShare(admin, 'x', { minRole: 'viewer', expiresInHours: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(listShares({ ...admin, role: 'viewer' }, R)).rejects.toMatchObject({ code: 'not_found' });
    await expect(revokeShare(admin, R, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(h.calls).toEqual([]);
  });

  it('refuses a report that is not ready and a role below the kind minimum', async () => {
    h.respond = (sql) => (sql.includes('FROM report_runs') ? [{ kind: 'product_summary', status: 'queued', live: true }] : []);
    await expect(createShare(admin, R, { minRole: 'agent', expiresInHours: 24 })).rejects.toMatchObject({ code: 'not_ready', status: 409 });
    h.respond = (sql) => (sql.includes('FROM report_runs') ? [{ kind: 'product_summary', status: 'ready', live: false }] : []);
    await expect(createShare(admin, R, { minRole: 'agent', expiresInHours: 24 })).rejects.toMatchObject({ code: 'not_ready' });
    h.respond = (sql) => (sql.includes('FROM report_runs') ? [{ kind: 'product_summary', status: 'ready', live: true }] : []);
    await expect(createShare(admin, R, { minRole: 'viewer', expiresInHours: 24 })).rejects.toMatchObject({ code: 'role_too_low', status: 400 });
    expect(h.calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it('caps the expiry at the report expiry in SQL and audits the share', async () => {
    process.env.APP_URL = 'https://app.bodhinox.test';
    h.respond = (sql) => {
      if (sql.includes('INSERT INTO report_shares')) return [{ id: S }];
      if (sql.includes('FROM report_runs')) return [{ kind: 'product_summary', status: 'ready', live: true }];
      if (sql.includes('FROM report_shares s')) return [shareRow];
      return [];
    };
    const share = await createShare(admin, R, { minRole: 'agent', expiresInHours: 168 });
    expect(share).toMatchObject({ id: S, reportId: R, minRole: 'agent', url: `https://app.bodhinox.test/reports/shared/${S}` });
    const insert = h.calls.find((c) => c.sql.includes('INSERT INTO report_shares'))!;
    expect(insert.sql).toContain('LEAST(now() + make_interval(hours => ?::int), r.expires_at)');
    expect(insert.values).toEqual(expect.arrayContaining([A, 'agent', U, 168, R]));
    const audit = h.calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))!;
    expect(audit.values).toEqual(expect.arrayContaining(['analytics.report_shared', R]));
  });

  it('revokes and audits; an unknown share is not found', async () => {
    h.respond = (sql) => (sql.includes('UPDATE report_shares') ? [{ revoked: true }] : []);
    await revokeShare(admin, R, S);
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))!.values).toContain('analytics.report_share_revoked');
    h.respond = () => [];
    await expect(revokeShare(admin, R, S)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('open (any member, live session)', () => {
  it('opens through the definer function with the live session context and audits the open', async () => {
    const viewer = { accountId: A, userId: U, role: 'viewer' as const };
    h.respond = (sql) => (sql.includes('crm_open_report_share')
      ? [{ run_id: R, object_key: `${A}/reports/${R}.pdf`, kind: 'campaign_summary', format: 'pdf',
        params: { from: '2026-10-01', to: '2026-10-07', timezone: 'UTC' } }] : []);
    expect(await openShare(viewer, S)).toEqual({ objectKey: `${A}/reports/${R}.pdf`, filename: 'campaign_summary_2026-10-01_2026-10-07.pdf', format: 'pdf' });
    expect(h.contexts).toEqual([viewer]);
    expect(h.calls.find((c) => c.sql.includes('crm_open_report_share'))!.values).toEqual([S]);
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO audit_logs'))!.values).toContain('analytics.report_share_opened');
  });

  it('answers not_found uniformly, without the database for a malformed id', async () => {
    await expect(openShare(admin, '../etc')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(h.calls).toEqual([]);
    await expect(openShare(admin, S)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(h.calls.some((c) => c.sql.includes('audit_logs'))).toBe(false);
  });
});
