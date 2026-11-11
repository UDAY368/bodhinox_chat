import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'agent', limited: false, blocked: false,
  list: vi.fn(), create: vi.fn(), update: vi.fn(), reconcile: vi.fn(),
}));

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
vi.mock('@/lib/platform/lifecycle', () => ({ manualRepliesBlocked: async () => h.blocked }));
vi.mock('@/lib/inbox/scheduled-replies', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/scheduled-replies')>()),
  listScheduledReplies: h.list,
  createScheduledReply: h.create,
  updateScheduledReply: h.update,
  reconcileScheduledReply: h.reconcile,
}));

import { ScheduledReplyError } from '@/lib/inbox/scheduled-replies';
import { InstagramError } from '@/lib/instagram/errors';
import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const post = (body: unknown) => POST(new Request('http://localhost/api/inbox/scheduled-replies', { method: 'POST', body: JSON.stringify(body) }));
const patch = (body: unknown) => PATCH(new Request('http://localhost/api/inbox/scheduled-replies/x', { method: 'PATCH', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: ROW }) });
const valid = () => ({ conversation_id: CONV, content: 'See you soon', send_at: future() });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.blocked = false;
  h.list.mockResolvedValue([]);
  h.create.mockImplementation(async () => ({ id: ROW, status: 'pending' }));
  h.update.mockResolvedValue({ id: ROW, status: 'cancelled' });
  h.reconcile.mockResolvedValue({ id: ROW, status: 'sent' });
});

describe('scheduled replies collection route', () => {
  it('lists a conversation’s replies for any member, uncached', async () => {
    h.role = 'viewer';
    const res = await GET(new Request(`http://localhost/api/inbox/scheduled-replies?conversation_id=${CONV}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, CONV);
  });

  it('answers 201 only after the store resolved, with the session identity', async () => {
    const res = await post(valid());
    expect(res.status).toBe(201);
    expect(h.create.mock.calls[0][0]).toEqual({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect((await res.json()).scheduled_reply.status).toBe('pending');
  });

  it('does not acknowledge a reply the store failed to queue', async () => {
    h.create.mockRejectedValue(new Error('database down'));
    expect((await post(valid())).status).toBe(500);
  });

  it('refuses viewers, a workspace blocked from manual replies, and rate-limited callers before storing', async () => {
    h.role = 'viewer';
    expect((await post(valid())).status).toBe(403);
    h.role = 'agent';
    h.blocked = true;
    expect((await post(valid())).status).toBe(403);
    h.blocked = false;
    h.limited = true;
    expect((await post(valid())).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses bad input with 400 and the Instagram rules with their codes', async () => {
    expect((await post({ ...valid(), content: '  ' })).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
    h.create.mockRejectedValue(new ScheduledReplyError('humanAgentOff', 409));
    const res = await post(valid());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('humanAgentOff');
    h.create.mockRejectedValue(new InstagramError('instagram_not_enabled'));
    expect((await post(valid())).status).toBe(503);
  });
});

describe('scheduled reply route', () => {
  it('cancels, edits and reconciles through the right store call', async () => {
    expect((await patch({ status: 'cancelled' })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, ROW, { kind: 'cancel' });
    expect((await patch({ content: 'later text' })).status).toBe(200);
    expect(h.update.mock.calls[1][2]).toEqual({ kind: 'edit', content: 'later text' });
    expect((await patch({ reconcile: 'sent' })).status).toBe(200);
    expect(h.reconcile).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, ROW, 'sent');
  });
  it('answers 404 for a row in another workspace and 409 for one already claimed', async () => {
    h.update.mockRejectedValue(new ScheduledReplyError('notFound', 404));
    expect((await patch({ status: 'cancelled' })).status).toBe(404);
    h.update.mockRejectedValue(new ScheduledReplyError('notPending', 409));
    expect((await patch({ status: 'cancelled' })).status).toBe(409);
  });
  it('refuses viewers and malformed bodies', async () => {
    expect((await patch({ status: 'sent' })).status).toBe(400);
    h.role = 'viewer';
    expect((await patch({ status: 'cancelled' })).status).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });
});
