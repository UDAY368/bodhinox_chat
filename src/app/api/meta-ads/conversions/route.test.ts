import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', list: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/meta-ads/capi', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/capi')>()),
  listConversionEvents: h.list,
}));

import { GET } from './route';

const ENV = { META_ADS_ENABLED: 'true', META_APP_ID: '123', META_APP_SECRET_PRIMARY: 'test-only', META_ADS_LOGIN_CONFIG_ID: '456' };
const saved = { ...process.env };
const get = (query = '') => GET(new Request(`http://localhost/api/meta-ads/conversions${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV);
  h.role = 'admin';
  h.list.mockResolvedValue({ events: [{ id: 'e1' }], nextCursor: 'next' });
});
afterEach(() => {
  process.env = { ...saved };
});

describe('GET /api/meta-ads/conversions', () => {
  it('lists events for an admin, no-store', async () => {
    const res = await get('?status=review');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ events: [{ id: 'e1' }], nextCursor: 'next' });
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, 'review', null);
  });

  it('answers 503 before any read while the feature is off', async () => {
    process.env.META_ADS_ENABLED = 'false';
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('meta_ads_not_enabled');
    expect(h.list).not.toHaveBeenCalled();
  });

  it('passes a valid cursor through as a parsed key', async () => {
    const cursor = Buffer.from('2026-11-01T10:00:00.123456Z|33333333-3333-4333-8333-333333333333').toString('base64url');
    expect((await get(`?cursor=${cursor}`)).status).toBe(200);
    expect(h.list).toHaveBeenCalledWith(expect.anything(), null,
      { createdKey: '2026-11-01T10:00:00.123456Z', id: '33333333-3333-4333-8333-333333333333' });
  });

  it.each([
    'bad',
    Buffer.from('2026-11-01T10:00:00.123Z|33333333-3333-4333-8333-333333333333').toString('base64url'),
    Buffer.from('2026-11-01T10:00:00.123456Z|not-a-uuid').toString('base64url'),
    Buffer.from("2026-11-01T10:00:00.123456Z|33333333-3333-4333-8333-333333333333|x").toString('base64url'),
    'a'.repeat(201),
  ])('rejects a malformed cursor %s before any read', async (cursor) => {
    const res = await get(`?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid');
    expect(h.list).not.toHaveBeenCalled();
  });

  it('rejects an unknown status filter', async () => {
    expect((await get('?status=everything')).status).toBe(400);
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await get()).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
  });
});
