// Stage 5 (5E): a member's open-conversation limit; admins and owners only.
// CSRF/mutation origin is enforced for every /api mutation by src/proxy.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', limited: false, get: vi.fn(), set: vi.fn() }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => ({ userId: ADMIN, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
}));
vi.mock('@/lib/data/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/server')>()),
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
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/inbox/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/routing')>()),
  getMemberCapacity: h.get,
  setMemberCapacity: h.set,
}));

import { RoutingRuleError } from '@/lib/inbox/routing';
import { GET, PUT } from './route';

const params = { params: Promise.resolve({ id: MEMBER }) };
const put = (body: unknown) => PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), params);
const capacity = { user_id: MEMBER, max_open_conversations: 5, open_conversations: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.get.mockResolvedValue(capacity);
  h.set.mockResolvedValue(capacity);
});

describe('member capacity route', () => {
  it('reads and sets the limit for admins, in the session workspace', async () => {
    const read = await GET(new Request('http://localhost/x'), params);
    expect(await read.json()).toEqual({ capacity });
    expect(read.headers.get('Cache-Control')).toContain('no-store');
    expect(h.get).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ADMIN, role: 'admin' }, MEMBER);
    expect((await put({ max_open_conversations: 5 })).status).toBe(200);
    expect(h.set).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: ADMIN, role: 'admin' }, MEMBER, 5);
    await put({ max_open_conversations: null });
    expect(h.set).toHaveBeenLastCalledWith(expect.anything(), MEMBER, null);
  });

  it('refuses agents and viewers before reading or writing', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await GET(new Request('http://localhost/x'), params)).status).toBe(403);
      expect((await put({ max_open_conversations: 5 })).status).toBe(403);
    }
    expect(h.get).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('answers 400 for a bad limit, 404 for a member of another workspace, 429 when rate-limited', async () => {
    expect(await (await put({ max_open_conversations: 0 })).json()).toMatchObject({ code: 'invalid_capacity' });
    expect(h.set).not.toHaveBeenCalled();
    h.set.mockRejectedValueOnce(new RoutingRuleError('not_found', 404));
    expect((await put({ max_open_conversations: 3 })).status).toBe(404);
    h.limited = true;
    expect((await put({ max_open_conversations: 3 })).status).toBe(429);
  });
});
