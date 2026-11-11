import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const VIEW = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', update: vi.fn(), remove: vi.fn() }));

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
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/inbox/saved-filters-store', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/saved-filters-store')>()),
  updateSavedFilter: h.update,
  deleteSavedFilter: h.remove,
}));

import { InboxPreferenceError } from '@/lib/inbox/saved-filters-store';
import { DELETE, PATCH } from './route';

const params = { params: Promise.resolve({ id: VIEW }) };
const patch = (body: unknown) =>
  PATCH(new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(body) }), params);
const remove = () => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params);
const tenant = { accountId: ACCOUNT, userId: USER, role: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.update.mockImplementation(async (_ctx, id, p) => ({ id, ...p }));
  h.remove.mockResolvedValue(undefined);
});

describe('saved filter item route', () => {
  it('renames and moves a view', async () => {
    const res = await patch({ name: ' New ', position: 3 });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(tenant, VIEW, { name: 'New', position: 3 });
  });

  it('replaces filters with the sanitised set', async () => {
    await patch({ filters: { filter: 'closed', session: 'nope' } });
    expect(h.update.mock.calls[0][2]).toEqual({
      filters: { filter: 'closed', session: 'all', tagIds: [], company: null, numberId: null, search: '', channel: null },
    });
  });

  it.each([
    [{}],
    [{ name: '' }],
    [{ position: -1 }],
    [{ position: 1.5 }],
    [{ position: 10_001 }],
    [{ filters: 'x' }],
  ])('rejects %j', async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('returns 404 for a view the caller does not own', async () => {
    h.update.mockRejectedValueOnce(new InboxPreferenceError('Not found', 404));
    expect((await patch({ name: 'x' })).status).toBe(404);
    h.remove.mockRejectedValueOnce(new InboxPreferenceError('Not found', 404));
    expect((await remove()).status).toBe(404);
  });

  it('deletes the caller own view', async () => {
    const res = await remove();
    expect(await res.json()).toEqual({ ok: true });
    expect(h.remove).toHaveBeenCalledWith(tenant, VIEW);
  });
});
