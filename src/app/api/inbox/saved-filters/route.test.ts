import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'agent', limited: false, list: vi.fn(), create: vi.fn() }));

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
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/inbox/saved-filters-store', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/saved-filters-store')>()),
  listSavedFilters: h.list,
  createSavedFilter: h.create,
}));

import { InboxPreferenceError } from '@/lib/inbox/saved-filters-store';
import { GET, POST } from './route';

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/inbox/saved-filters', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.list.mockResolvedValue([]);
  h.create.mockImplementation(async (_ctx, input) => ({ id: 'x', position: 0, created_at: 'now', ...input }));
});

describe('saved filters collection route', () => {
  it('lists the caller own views with the session tenant, viewers included', async () => {
    h.role = 'viewer';
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved_filters: [] });
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' });
  });

  it('saves a sanitised view under the session identity, ignoring a supplied user_id', async () => {
    const res = await post({ name: ' Hot leads ', filters: { filter: 'unread', tagIds: ['bad'], evil: 'x' }, user_id: 'someone-else' });
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(
      { accountId: ACCOUNT, userId: USER, role: 'agent' },
      { name: 'Hot leads', filters: { filter: 'unread', session: 'all', tagIds: [], company: null, numberId: null, search: '', channel: null } }
    );
  });

  it.each([
    ['not json'],
    [{ filters: {} }],
    [{ name: 'x' }],
    [{ name: 'x', filters: [] }],
    [{ name: 'x'.repeat(81), filters: {} }],
  ])('rejects %j', async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('maps the per-member cap to 409 and rate limits writes', async () => {
    h.create.mockRejectedValueOnce(new InboxPreferenceError('Limit', 409));
    expect((await post({ name: 'x', filters: {} })).status).toBe(409);
    h.limited = true;
    expect((await post({ name: 'x', filters: {} })).status).toBe(429);
  });

  it('hides unexpected errors', async () => {
    h.list.mockRejectedValueOnce(new Error('db exploded with secrets'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secrets');
  });
});
