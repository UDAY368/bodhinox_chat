// Stage 5 (5E): role checks and tenancy wiring of the label and favourite routes.
// CSRF/mutation origin is enforced for every /api mutation by src/proxy.ts (its own tests).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LABEL = '33333333-3333-4333-8333-333333333333';
const CONV = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'agent', limited: false,
  listLabels: vi.fn(), listLinks: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setLink: vi.fn(),
  listFavourites: vi.fn(), setFavourite: vi.fn(),
}));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
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
vi.mock('@/lib/inbox/labels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/labels')>()),
  listLabels: h.listLabels,
  listLabelLinks: h.listLinks,
  createLabel: h.create,
  updateLabel: h.update,
  deleteLabel: h.remove,
  setConversationLabel: h.setLink,
}));
vi.mock('@/lib/inbox/favourites', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inbox/favourites')>()),
  listFavourites: h.listFavourites,
  setFavourite: h.setFavourite,
}));

import { LabelError } from '@/lib/inbox/labels';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';
import { DELETE as UNLINK, PUT as LINK } from './[id]/conversations/[conversationId]/route';
import { GET as FAVOURITES, PUT as FAVOURITE } from '../favourites/route';

const tenant = { accountId: ACCOUNT, userId: USER, role: 'agent' };
const json = (body: unknown) => JSON.stringify(body);
const idParams = { params: Promise.resolve({ id: LABEL }) };
const linkParams = { params: Promise.resolve({ id: LABEL, conversationId: CONV }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.listLabels.mockResolvedValue([{ id: LABEL, name: 'VIP', color: 'blue' }]);
  h.listLinks.mockResolvedValue([{ conversation_id: CONV, label_id: LABEL }]);
  h.create.mockResolvedValue({ id: LABEL, name: 'VIP', color: 'gray' });
  h.update.mockResolvedValue({ id: LABEL, name: 'Gold', color: 'gray' });
  h.listFavourites.mockResolvedValue([CONV]);
});

describe('labels collection', () => {
  it('lists for every member, scoped to the session workspace and the asked channel, uncached', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('http://localhost/api/inbox/labels?channel=instagram'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await res.json()).toEqual({ labels: [{ id: LABEL, name: 'VIP', color: 'blue' }], links: [{ conversation_id: CONV, label_id: LABEL }] });
    expect(h.listLinks).toHaveBeenCalledWith({ ...tenant, role: 'viewer' }, 'instagram');
    await GET(new Request('http://localhost/api/inbox/labels?channel=sms'));
    expect(h.listLinks).toHaveBeenLastCalledWith({ ...tenant, role: 'viewer' }, undefined);
  });

  it('creates for agents and above, refuses viewers, validates, and rate-limits', async () => {
    const post = (body: unknown) => POST(new Request('http://localhost/api/inbox/labels', { method: 'POST', body: json(body) }));
    expect((await post({ name: 'VIP' })).status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(tenant, { name: 'VIP', color: 'gray' });
    expect((await post({ name: '' })).status).toBe(400);
    h.create.mockRejectedValueOnce(new LabelError('limit', 409));
    expect(await (await post({ name: 'One more' })).json()).toMatchObject({ code: 'limit' });
    h.limited = true;
    expect((await post({ name: 'VIP' })).status).toBe(429);
    h.limited = false;
    h.role = 'viewer';
    expect((await post({ name: 'VIP' })).status).toBe(403);
    expect(h.create).toHaveBeenCalledTimes(2);
  });
});

describe('one label', () => {
  it('renames and deletes for agents, 404 for another workspace, refuses viewers', async () => {
    const patch = (body: unknown) => PATCH(new Request('http://localhost/x', { method: 'PATCH', body: json(body) }), idParams);
    expect((await patch({ name: 'Gold' })).status).toBe(200);
    expect(h.update).toHaveBeenCalledWith(tenant, LABEL, { name: 'Gold' });
    h.remove.mockRejectedValueOnce(new LabelError('not_found', 404));
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), idParams)).status).toBe(404);
    h.role = 'viewer';
    expect((await patch({ name: 'Gold' })).status).toBe(403);
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), idParams)).status).toBe(403);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(1);
  });

  it('applies and removes a label on a conversation for agents only', async () => {
    expect((await LINK(new Request('http://localhost/x', { method: 'PUT' }), linkParams)).status).toBe(200);
    expect(h.setLink).toHaveBeenLastCalledWith(tenant, LABEL, CONV, true);
    expect((await UNLINK(new Request('http://localhost/x', { method: 'DELETE' }), linkParams)).status).toBe(200);
    expect(h.setLink).toHaveBeenLastCalledWith(tenant, LABEL, CONV, false);
    // A conversation hidden by agent visibility (or another workspace's) answers 404.
    h.setLink.mockRejectedValueOnce(new LabelError('not_found', 404));
    expect((await LINK(new Request('http://localhost/x', { method: 'PUT' }), linkParams)).status).toBe(404);
    h.role = 'viewer';
    expect((await LINK(new Request('http://localhost/x', { method: 'PUT' }), linkParams)).status).toBe(403);
    expect(h.setLink).toHaveBeenCalledTimes(3);
  });
});

describe('favourites', () => {
  it('are personal: every member reads and sets their own', async () => {
    h.role = 'viewer';
    expect(await (await FAVOURITES()).json()).toEqual({ conversation_ids: [CONV] });
    expect(h.listFavourites).toHaveBeenCalledWith({ ...tenant, role: 'viewer' });
    const put = (body: unknown) => FAVOURITE(new Request('http://localhost/x', { method: 'PUT', body: json(body) }));
    expect((await put({ conversation_id: CONV, favourite: true })).status).toBe(200);
    expect(h.setFavourite).toHaveBeenCalledWith({ ...tenant, role: 'viewer' }, CONV, true);
    expect((await put({ conversation_id: CONV })).status).toBe(400);
    h.setFavourite.mockRejectedValueOnce(new LabelError('not_found', 404));
    expect((await put({ conversation_id: CONV, favourite: false })).status).toBe(404);
  });
});
