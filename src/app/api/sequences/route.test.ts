import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SEQ = '33333333-3333-4333-8333-333333333333';
const MSG = '44444444-4444-4444-8444-444444444444';
const FLOW = '55555555-5555-4555-8555-555555555555';
const CONTACT = '66666666-6666-4666-8666-666666666666';
const h = vi.hoisted(() => ({
  role: 'agent', limited: false, instagram: true,
  list: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), archive: vi.fn(), add: vi.fn(), reorder: vi.fn(),
  updateMessage: vi.fn(), deleteMessage: vi.fn(), subscribers: vi.fn(), change: vi.fn(),
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
vi.mock('@/lib/instagram/config', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/config')>()),
  instagramConfig: () => (h.instagram ? { enabled: true } : null),
}));
vi.mock('@/lib/sequences/store', async (original) => ({
  ...(await original<typeof import('@/lib/sequences/store')>()),
  listSequences: h.list,
  createSequence: h.create,
  getSequence: h.get,
  updateSequence: h.update,
  archiveSequence: h.archive,
  addMessage: h.add,
  reorderMessages: h.reorder,
  updateMessage: h.updateMessage,
  deleteMessage: h.deleteMessage,
  listSubscribers: h.subscribers,
  changeSubscriber: h.change,
}));

import { SequenceError } from '@/lib/sequences/store';
import { GET as listRoute, POST as createRoute } from './route';
import { DELETE as archiveRoute, GET as getRoute, PATCH as patchRoute } from './[id]/route';
import { POST as addRoute, PUT as reorderRoute } from './[id]/messages/route';
import { DELETE as deleteMessageRoute, PATCH as patchMessageRoute } from './[id]/messages/[messageId]/route';
import { GET as subscribersRoute, POST as changeRoute } from './[id]/subscribers/route';

const me = () => ({ accountId: ACCOUNT, userId: USER, role: h.role });
const req = (method: string, body?: unknown) =>
  new Request('http://localhost/api/sequences', { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const p = { params: Promise.resolve({ id: SEQ }) };
const pm = { params: Promise.resolve({ id: SEQ, messageId: MSG }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.instagram = true;
  for (const fn of [h.list, h.subscribers]) fn.mockResolvedValue([]);
  for (const fn of [h.create, h.get, h.update, h.add, h.reorder, h.updateMessage, h.deleteMessage])
    fn.mockResolvedValue({ id: SEQ, items: [] });
  h.archive.mockResolvedValue(undefined);
  h.change.mockResolvedValue({ status: 'subscribed' });
});

describe('sequence routes', () => {
  it('lets any member read, uncached, with the session identity', async () => {
    h.role = 'viewer';
    const list = await listRoute();
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.list).toHaveBeenCalledWith(me());
    expect((await getRoute(req('GET'), p)).status).toBe(200);
    expect(h.get).toHaveBeenCalledWith(me(), SEQ);
    expect((await subscribersRoute(req('GET'), p)).status).toBe(200);
  });

  it('refuses every write below the agent role before the store is called', async () => {
    h.role = 'viewer';
    const writes = [
      createRoute(req('POST', { name: 'Welcome' })),
      patchRoute(req('PATCH', { status: 'paused' }), p),
      archiveRoute(req('DELETE'), p),
      addRoute(req('POST', { flow_id: FLOW }), p),
      reorderRoute(req('PUT', { order: [MSG] }), p),
      patchMessageRoute(req('PATCH', { active: false }), pm),
      deleteMessageRoute(req('DELETE'), pm),
      changeRoute(req('POST', { action: 'unsubscribe', contact_id: CONTACT }), p),
    ];
    for (const res of await Promise.all(writes)) expect(res.status).toBe(403);
    for (const fn of [h.create, h.update, h.archive, h.add, h.reorder, h.updateMessage, h.deleteMessage, h.change])
      expect(fn).not.toHaveBeenCalled();
  });

  it('answers 503 while Instagram is off and 429 when rate limited', async () => {
    h.instagram = false;
    expect((await listRoute()).status).toBe(503);
    expect((await createRoute(req('POST', { name: 'Welcome' }))).status).toBe(503);
    h.instagram = true;
    h.limited = true;
    expect((await createRoute(req('POST', { name: 'Welcome' }))).status).toBe(429);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('passes parsed input to the store', async () => {
    expect((await createRoute(req('POST', { name: '  Welcome  ' }))).status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(me(), 'Welcome');
    await patchRoute(req('PATCH', { name: 'Renamed', status: 'paused' }), p);
    expect(h.update).toHaveBeenCalledWith(me(), SEQ, { name: 'Renamed', status: 'paused' });
    expect((await addRoute(req('POST', { create: { name: 'Day one' } }), p)).status).toBe(201);
    expect(h.add).toHaveBeenCalledWith(me(), SEQ, { kind: 'new', name: 'Day one' });
    await addRoute(req('POST', { flow_id: FLOW }), p);
    expect(h.add).toHaveBeenLastCalledWith(me(), SEQ, { kind: 'existing', flowId: FLOW });
    await reorderRoute(req('PUT', { order: [MSG] }), p);
    expect(h.reorder).toHaveBeenCalledWith(me(), SEQ, [MSG]);
    await patchMessageRoute(req('PATCH', { delay_amount: 2, delay_unit: 'days', active: false }), pm);
    expect(h.updateMessage).toHaveBeenCalledWith(me(), SEQ, MSG, { delay: { amount: 2, unit: 'days' }, active: false });
    await changeRoute(req('POST', { action: 'unsubscribe', contact_id: CONTACT }), p);
    expect(h.change).toHaveBeenCalledWith(me(), SEQ, { action: 'unsubscribe', contactId: CONTACT });
  });

  it('refuses malformed bodies with 400', async () => {
    const bad = [
      createRoute(req('POST', { name: ' ' })),
      createRoute(req('POST', { name: 'x'.repeat(101) })),
      patchRoute(req('PATCH', { status: 'archived' }), p),
      patchRoute(req('PATCH', { name: 'ok', extra: 1 }), p),
      addRoute(req('POST', { flow_id: 'not-a-uuid' }), p),
      addRoute(req('POST', { flow_id: FLOW, create: { name: 'both' } }), p),
      patchMessageRoute(req('PATCH', { delay_amount: 400, delay_unit: 'days' }), pm),
      patchMessageRoute(req('PATCH', { delay_amount: 1, delay_unit: 'weeks' }), pm),
      patchMessageRoute(req('PATCH', {}), pm),
      changeRoute(req('POST', { action: 'subscribe', contact_id: 'x' }), p),
    ];
    for (const res of await Promise.all(bad)) expect(res.status).toBe(400);
  });

  it('maps store refusals to their status and code', async () => {
    h.get.mockRejectedValue(new SequenceError('notFound', 404));
    const res = await getRoute(req('GET'), p);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('notFound');
    h.add.mockRejectedValue(new SequenceError('tooManyMessages', 409));
    expect((await addRoute(req('POST', { flow_id: FLOW }), p)).status).toBe(409);
    h.deleteMessage.mockRejectedValue(Object.assign(new Error('rls'), { code: '42501' }));
    expect((await deleteMessageRoute(req('DELETE'), pm)).status).toBe(403);
    h.create.mockRejectedValue(new Error('database down'));
    expect((await createRoute(req('POST', { name: 'Welcome' }))).status).toBe(500);
  });
});
