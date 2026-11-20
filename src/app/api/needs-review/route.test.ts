import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'admin', session: true, mutationOk: true, rateOk: true,
  list: vi.fn(), count: vi.fn(), resolve: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.session) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { ForbiddenError } = await import('@/lib/auth/errors');
      throw new ForbiddenError('Invalid request origin');
    }
  },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: h.rateOk }),
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
}));
vi.mock('@/lib/needs-review/review', async (original) => ({
  ...(await original<typeof import('@/lib/needs-review/review')>()),
  listNeedsReview: h.list,
  countNeedsReview: h.count,
  resolveNeedsReview: h.resolve,
}));

import { NeedsReviewError } from '@/lib/needs-review/review';
import { GET } from './route';
import { POST } from './[id]/resolve/route';

const get = (query = '') => GET(new Request(`http://localhost/api/needs-review${query}`));
const post = (body: unknown, id = INTENT) =>
  POST(new Request(`http://localhost/api/needs-review/${id}/resolve`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) });
const tenant = (role: string) => ({ accountId: ACCOUNT, userId: USER, role });

beforeEach(() => {
  Object.assign(h, { role: 'admin', session: true, mutationOk: true, rateOk: true });
  h.list.mockReset().mockResolvedValue({ items: [], total: 0, page: 0, page_size: 25 });
  h.count.mockReset().mockResolvedValue(3);
  h.resolve.mockReset().mockResolvedValue({ id: INTENT, action: 'was_sent', requeued: false });
});

describe('GET /api/needs-review', () => {
  it('lists for admins and owners, scoped to the session workspace', async () => {
    for (const role of ['admin', 'owner']) {
      h.role = role;
      const res = await get('?kind=order&page=2');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(h.list).toHaveBeenLastCalledWith(tenant(role), { kind: 'order', page: 2 });
    }
  });

  it('answers the count alone for the badge', async () => {
    const res = await get('?count=1');
    expect(await res.json()).toEqual({ total: 3 });
    expect(h.list).not.toHaveBeenCalled();
  });

  it('refuses agents, viewers and a missing session', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await get()).status).toBe(403);
      expect((await get('?count=1')).status).toBe(403);
    }
    h.session = false;
    expect((await get()).status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.count).not.toHaveBeenCalled();
  });

  it('refuses an unknown kind or page', async () => {
    for (const query of ['?kind=secrets', '?page=-1', '?page=1.5', '?page=x'])
      expect((await get(query)).status).toBe(400);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/needs-review/[id]/resolve', () => {
  it('resolves for an admin with the session tenant, never an id from the body', async () => {
    const res = await post({ action: 'send_again', account_id: 'x' });
    expect(res.status).toBe(200);
    expect(h.resolve).toHaveBeenCalledWith(tenant('admin'), INTENT, 'send_again');
  });

  it('refuses agents and viewers', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await post({ action: 'was_sent' })).status).toBe(403);
    }
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('refuses a mutation without the Origin and CSRF proof', async () => {
    h.role = 'owner';
    h.mutationOk = false;
    expect((await post({ action: 'was_sent' })).status).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('rate limits, and refuses a missing or unknown action', async () => {
    for (const body of [null, {}, { action: 'delete' }, ['was_sent']])
      expect((await post(body)).status).toBe(400);
    h.rateOk = false;
    expect((await post({ action: 'was_sent' })).status).toBe(429);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('maps not found and not open', async () => {
    h.resolve.mockRejectedValueOnce(new NeedsReviewError('not_found', 404));
    const missing = await post({ action: 'was_sent' });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('not_found');
    h.resolve.mockRejectedValueOnce(new NeedsReviewError('not_open', 409));
    expect((await post({ action: 'send_again' })).status).toBe(409);
  });
});
