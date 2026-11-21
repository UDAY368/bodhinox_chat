// POST /api/inbox/conversations/bulk: session, Origin/CSRF proof, agent role and rate limit before
// anything changes; the action runs in the session's workspace; fixed codes for refusals.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  role: 'agent', signedIn: true, mutationOk: true, limited: false, calls: [] as unknown[][], fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).ForbiddenError('Invalid origin');
  },
}));
vi.mock('@/lib/rate-limit', async (original) => ({
  ...(await original<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: async () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({ error: 'rate_limited' }, { status: 429 }),
}));
vi.mock('@/lib/inbox/bulk-actions', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/bulk-actions')>()),
  bulkConversationAction: async (...args: unknown[]) => {
    if (h.fail) throw h.fail;
    h.calls.push(args);
    return { matched: 1, changed: 1, refusedIds: [] };
  },
}));

import { BulkConversationError } from '@/lib/inbox/bulk-actions';
import { ConversationActionError } from '@/lib/inbox/conversation-actions';
import { POST } from './route';

const body = { action: { type: 'resolve' }, target: { ids: [CONVERSATION] } };
const call = () => POST(new Request('http://localhost/api/inbox/conversations/bulk', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  h.role = 'agent';
  h.signedIn = true;
  h.mutationOk = true;
  h.limited = false;
  h.calls = [];
  h.fail = null;
});

describe('POST /api/inbox/conversations/bulk', () => {
  it('runs the action for an agent in the session workspace', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await res.json()).toEqual({ matched: 1, changed: 1, refusedIds: [] });
    expect(h.calls).toEqual([[{ accountId: ACCOUNT, userId: USER, role: 'agent' }, body]]);
  });

  it('refuses a viewer, a failed CSRF/Origin check and a missing session before changing anything', async () => {
    h.role = 'viewer';
    expect((await call()).status).toBe(403);
    h.role = 'owner';
    h.mutationOk = false;
    expect((await call()).status).toBe(403);
    h.mutationOk = true;
    h.signedIn = false;
    expect((await call()).status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('answers 429 when rate limited, and fixed codes for refusals', async () => {
    h.limited = true;
    expect((await call()).status).toBe(429);
    expect(h.calls).toEqual([]);
    h.limited = false;
    h.fail = new BulkConversationError('too_many', 400, 6000);
    let res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'too_many', matched: 6000 });
    h.fail = new ConversationActionError('not_found', 404);
    res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
  });
});
