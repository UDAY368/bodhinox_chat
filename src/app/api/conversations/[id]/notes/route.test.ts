import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' };
const CONV = '55555555-5555-4555-8555-555555555555';
const h = vi.hoisted(() => ({ requireRole: vi.fn(), list: vi.fn(), create: vi.fn(), limited: false }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) => Response.json({ error: 'x' }, { status: (e as { status?: number })?.status ?? 500 }),
}));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/inbox/notes', async (orig) => ({
  ...(await orig<typeof import('@/lib/inbox/notes')>()),
  listConversationNotes: h.list,
  createConversationNote: h.create,
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { NoteError } from '@/lib/inbox/notes';
import { GET, POST } from './route';

const params = { params: Promise.resolve({ id: CONV }) };
const post = (body: unknown) => POST(new Request(`http://localhost/api/conversations/${CONV}/notes`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
}), params);

beforeEach(() => {
  vi.clearAllMocks();
  h.limited = false;
  h.requireRole.mockResolvedValue(ctx);
});

it('lists notes for any member, viewers included', async () => {
  h.list.mockResolvedValueOnce([{ id: 'n1', body: 'hi' }]);
  const res = await GET(new Request('http://localhost/x'), params);
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith('viewer');
  expect(h.list).toHaveBeenCalledWith({}, ctx.accountId, CONV);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toEqual({ notes: [{ id: 'n1', body: 'hi' }] });
});

it('maps an unknown conversation to 404', async () => {
  h.list.mockRejectedValueOnce(new NoteError('not_found', 404));
  const res = await GET(new Request('http://localhost/x'), params);
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ code: 'not_found' });
});

it('requires an agent to write and refuses viewers before touching data', async () => {
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }));
  expect((await post({ body: 'x' })).status).toBe(403);
  expect(h.create).not.toHaveBeenCalled();
});

it('creates a note as the session member with the given mentions', async () => {
  h.create.mockResolvedValueOnce({ note: { id: 'n1' }, notified: ['u'] });
  const res = await post({ body: 'hello', mentions: ['m1'], author_id: 'someone-else' });
  expect(res.status).toBe(201);
  expect(h.requireRole).toHaveBeenCalledWith('agent');
  expect(h.create).toHaveBeenCalledWith({}, { accountId: ctx.accountId, userId: ctx.userId, role: 'agent' }, CONV, { body: 'hello', mentions: ['m1'] });
  expect(await res.json()).toEqual({ note: { id: 'n1' } });
});

it('rejects malformed bodies, invalid input and rate-limited callers', async () => {
  expect((await post('not json')).status).toBe(400);
  expect((await post([1])).status).toBe(400);
  h.create.mockRejectedValueOnce(new NoteError('invalid_body', 400));
  const res = await post({ body: '' });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: 'invalid_body' });
  h.limited = true;
  expect((await post({ body: 'x' })).status).toBe(429);
});

it('turns a database permission refusal into 403', async () => {
  h.create.mockRejectedValueOnce(Object.assign(new Error('rls'), { code: '42501' }));
  expect((await post({ body: 'x' })).status).toBe(403);
});
