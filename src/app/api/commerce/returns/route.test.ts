import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'agent', list: vi.fn() }));

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
vi.mock('@/lib/commerce/returns-queue', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/returns-queue')>()),
  listReturnQueue: h.list,
}));

import { GET } from './route';

const get = (query = '') => GET(new Request(`http://localhost/api/commerce/returns${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.list.mockResolvedValue({ returns: [], total: 0 });
});

describe('GET /api/commerce/returns', () => {
  it('lists the caller workspace queue with the status filter and page', async () => {
    const res = await get('?status=open&page=2');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ returns: [], total: 0 });
    const [ctx, query] = h.list.mock.calls[0];
    expect(ctx).toMatchObject({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect(query).toEqual({ status: 'open', page: 2 });
  });

  it('defaults to every return, first page', async () => {
    await get();
    expect(h.list.mock.calls[0][1]).toEqual({ page: 0 });
  });

  it('refuses viewers', async () => {
    h.role = 'viewer';
    expect((await get()).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
  });

  it.each(['?status=pending', '?status=OPEN', '?page=-1', '?page=abc', '?page=99999'])('rejects %s', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(h.list).not.toHaveBeenCalled();
  });
});
