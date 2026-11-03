import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const TEMPLATE_ID = '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

const auth = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', async (original) => ({
  ...(await original<typeof import('@/lib/auth/account')>()),
  requireRole: auth.requireRole,
}));

const sql = vi.hoisted(() => ({ calls: [] as { text: string; values: unknown[] }[], template: [] as unknown[] }));
const tx = {
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sql.calls.push({ text: strings.join('?'), values });
    return sql.template;
  }),
};
const analytics = vi.hoisted(() => ({ templateDaily: vi.fn(), runAnalytics: vi.fn() }));
vi.mock('@/lib/analytics/queries', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/queries')>()),
  runAnalytics: analytics.runAnalytics,
  templateDaily: analytics.templateDaily,
}));

import { ForbiddenError } from '@/lib/auth/account';
import { AnalyticsInputError } from '@/lib/analytics/queries';
import { GET } from './route';

const get = (query = '') => GET(new Request(`http://localhost/api/analytics/templates${query}`));

beforeEach(() => {
  sql.calls.length = 0;
  sql.template = [];
  auth.requireRole.mockReset();
  auth.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: `user-${Math.random()}`, role: 'viewer' });
  analytics.runAnalytics.mockReset();
  analytics.runAnalytics.mockImplementation(async (_ctx, op) => op(tx, 'UTC'));
  analytics.templateDaily.mockReset();
  analytics.templateDaily.mockResolvedValue([]);
});

describe('GET /api/analytics/templates', () => {
  it('reports the whole workspace for any member, scoped to their account', async () => {
    analytics.templateDaily.mockResolvedValue([
      { day: '2026-11-02', templateName: 'promo', sent: 5, delivered: 4, read: 3, replied: 1, clicked: 1, failed: 1 },
    ]);
    const res = await get('?preset=7d');
    expect(res.status).toBe(200);
    expect(auth.requireRole).toHaveBeenCalledWith('viewer');
    expect(analytics.runAnalytics).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: expect.any(String), role: 'viewer' }, expect.any(Function));
    const [, account, range, name] = analytics.templateDaily.mock.calls[0];
    expect(account).toBe(ACCOUNT);
    expect(range).toMatchObject({ preset: '7d', days: 7, timezone: 'UTC' });
    expect(name).toBeNull();
    const body = await res.json();
    expect(body.template).toBeNull();
    expect(body.series).toHaveLength(7);
    expect(body.totals).toEqual({ sent: 5, delivered: 4, read: 3, replied: 1, clicked: 1, failed: 1 });
    expect(body.templates).toEqual([{ templateName: 'promo', sent: 5, delivered: 4, read: 3, replied: 1, clicked: 1, failed: 1 }]);
    expect(body.range).toMatchObject({ preset: '7d', bucket: 'day', timezone: 'UTC' });
  });

  it('reports one template by its name after finding it in the caller account', async () => {
    sql.template = [{ id: TEMPLATE_ID, name: 'promo', language: 'en_US', category: 'MARKETING', status: 'APPROVED', quality_score: 'GREEN' }];
    const res = await get(`?templateId=${TEMPLATE_ID}&preset=custom&from=2026-01-01&to=2026-03-31`);
    expect(res.status).toBe(200);
    expect(sql.calls[0].text).toContain('FROM message_templates WHERE account_id=');
    expect(sql.calls[0].values).toEqual([ACCOUNT, TEMPLATE_ID]);
    expect(analytics.templateDaily.mock.calls[0][3]).toBe('promo');
    const body = await res.json();
    expect(body.template.name).toBe('promo');
    expect(body.templates).toEqual([]);
    expect(body.range).toMatchObject({ startDay: '2026-01-01', endDay: '2026-03-31', days: 90 });
  });

  it('is a 404 for a template outside the account, without running the report', async () => {
    const res = await get(`?templateId=${TEMPLATE_ID}`);
    expect(res.status).toBe(404);
    expect(analytics.templateDaily).not.toHaveBeenCalled();
  });

  it('rejects a malformed template id before authenticating', async () => {
    const res = await get('?templateId=nope');
    expect(res.status).toBe(400);
    expect(auth.requireRole).not.toHaveBeenCalled();
  });

  it('rejects a bad range', async () => {
    expect((await get('?preset=forever')).status).toBe(400);
    expect((await get('?preset=custom&from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await get('?preset=custom&from=2026-03-02&to=2026-03-01')).status).toBe(400);
    expect(analytics.templateDaily).not.toHaveBeenCalled();
  });

  it('maps an invalid filter from the query layer to 400', async () => {
    analytics.templateDaily.mockRejectedValue(new AnalyticsInputError('Invalid template'));
    expect((await get()).status).toBe(400);
  });

  it('refuses callers without a workspace role', async () => {
    auth.requireRole.mockRejectedValue(new ForbiddenError());
    expect((await get()).status).toBe(403);
    expect(analytics.runAnalytics).not.toHaveBeenCalled();
  });

  it('rate-limits one user', async () => {
    auth.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: 'busy-user', role: 'viewer' });
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await get()).status;
    expect(last).toBe(429);
  });

  it('does not leak database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    analytics.templateDaily.mockRejectedValue(new Error('relation secret_table does not exist'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret_table');
  });
});
