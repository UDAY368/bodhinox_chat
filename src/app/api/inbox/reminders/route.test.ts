import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', limited: false, list: vi.fn(), create: vi.fn(), update: vi.fn() }));

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
vi.mock('@/lib/inbox/reminders', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/reminders')>()),
  listReminders: h.list,
  createReminder: h.create,
  updateReminder: h.update,
}));

import { ReminderError } from '@/lib/inbox/reminders';
import { GET, POST } from './route';
import { PATCH } from './[id]/route';

const future = () => new Date(Date.now() + 3_600_000).toISOString();
const post = (body: unknown) => POST(new Request('http://localhost/api/inbox/reminders', { method: 'POST', body: JSON.stringify(body) }));
const patch = (body: unknown) => PATCH(new Request('http://localhost/api/inbox/reminders/x', { method: 'PATCH', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: CONV }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.list.mockResolvedValue([]);
  h.create.mockImplementation(async (_ctx, input) => ({ id: 'r1', ...input }));
  h.update.mockResolvedValue({ id: 'r1' });
});

describe('reminders collection route', () => {
  it('lists with the session tenant, viewers included, uncached', async () => {
    h.role = 'viewer';
    const res = await GET(new Request(`http://localhost/api/inbox/reminders?conversation_id=${CONV}&kind=snooze`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, { conversationId: CONV, kind: 'snooze', status: null });
  });

  it('creates for an agent with the session identity, never one from the body', async () => {
    const res = await post({ conversation_id: CONV, remind_at: future(), user_id: 'someone-else' });
    expect(res.status).toBe(201);
    expect(h.create.mock.calls[0][0]).toEqual({ accountId: ACCOUNT, userId: USER, role: 'agent' });
    expect(JSON.stringify(h.create.mock.calls[0][1])).not.toContain('someone-else');
  });

  it('refuses a viewer before reading the body or touching the store', async () => {
    h.role = 'viewer';
    const res = await post({ conversation_id: CONV, remind_at: future() });
    expect(res.status).toBe(403);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('answers 400 for bad input without storing, 429 when rate limited, 404 for an unreadable conversation', async () => {
    expect((await post({ conversation_id: CONV, remind_at: new Date(0).toISOString() })).status).toBe(400);
    expect(h.create).not.toHaveBeenCalled();
    h.create.mockRejectedValue(new ReminderError('notFound', 404));
    const missing = await post({ conversation_id: CONV, remind_at: future() });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('notFound');
    h.limited = true;
    expect((await post({ conversation_id: CONV, remind_at: future() })).status).toBe(429);
  });

  it('maps a database permission refusal to 403', async () => {
    h.create.mockRejectedValue(Object.assign(new Error('rls'), { code: 'P2010', meta: { code: '42501' } }));
    expect((await post({ conversation_id: CONV, remind_at: future() })).status).toBe(403);
  });
});

describe('reminder route', () => {
  it('changes only through the member’s own tenant, 404 for a row that is not theirs', async () => {
    expect((await patch({ status: 'dismissed' })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, CONV, { status: 'dismissed' });
    h.update.mockRejectedValue(new ReminderError('notFound', 404));
    expect((await patch({ status: 'cancelled' })).status).toBe(404);
  });
  it('refuses viewers and malformed bodies', async () => {
    expect((await patch({})).status).toBe(400);
    h.role = 'viewer';
    expect((await patch({ status: 'dismissed' })).status).toBe(403);
  });
});
