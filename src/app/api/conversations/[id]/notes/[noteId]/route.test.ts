import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' };
const CONV = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const h = vi.hoisted(() => ({ requireRole: vi.fn(), update: vi.fn(), remove: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) => Response.json({ error: 'x' }, { status: (e as { status?: number })?.status ?? 500 }),
}));
vi.mock('@/lib/i18n/translate', () => ({ getT: () => (key: string) => key }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/inbox/notes', async (orig) => ({
  ...(await orig<typeof import('@/lib/inbox/notes')>()),
  updateConversationNote: h.update,
  deleteConversationNote: h.remove,
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));

import { NoteError } from '@/lib/inbox/notes';
import { DELETE, PATCH } from './route';

const params = { params: Promise.resolve({ id: CONV, noteId: NOTE }) };
const url = `http://localhost/api/conversations/${CONV}/notes/${NOTE}`;
const actor = { accountId: ctx.accountId, userId: ctx.userId, role: 'agent' };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue(ctx);
});

it('edits through the library as the session member', async () => {
  h.update.mockResolvedValueOnce({ note: { id: NOTE, body: 'new' }, notified: [] });
  const res = await PATCH(new Request(url, { method: 'PATCH', body: JSON.stringify({ body: 'new', mentions: [] }) }), params);
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith('agent');
  expect(h.update).toHaveBeenCalledWith({}, actor, CONV, NOTE, { body: 'new', mentions: [] });
  expect(await res.json()).toEqual({ note: { id: NOTE, body: 'new' } });
});

it('reports a non-author edit as 403 and a missing note as 404', async () => {
  h.update.mockRejectedValueOnce(new NoteError('forbidden', 403));
  expect((await PATCH(new Request(url, { method: 'PATCH', body: JSON.stringify({ body: 'x' }) }), params)).status).toBe(403);
  h.update.mockRejectedValueOnce(new NoteError('not_found', 404));
  expect((await PATCH(new Request(url, { method: 'PATCH', body: JSON.stringify({ body: 'x' }) }), params)).status).toBe(404);
  expect((await PATCH(new Request(url, { method: 'PATCH', body: 'nope' }), params)).status).toBe(400);
});

it('soft-deletes, and viewers cannot', async () => {
  h.remove.mockResolvedValueOnce(undefined);
  const res = await DELETE(new Request(url, { method: 'DELETE' }), params);
  expect(res.status).toBe(200);
  expect(h.remove).toHaveBeenCalledWith({}, actor, CONV, NOTE);
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }));
  expect((await DELETE(new Request(url, { method: 'DELETE' }), params)).status).toBe(403);
  expect(h.remove).toHaveBeenCalledTimes(1);
});
