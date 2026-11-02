import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const QR = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({ role: 'agent', list: vi.fn(), set: vi.fn() }));

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
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/inbox/saved-filters-store', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/saved-filters-store')>()),
  listQuickReplyFavourites: h.list,
  setQuickReplyFavourite: h.set,
}));

import { InboxPreferenceError } from '@/lib/inbox/saved-filters-store';
import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.list.mockResolvedValue([QR]);
  h.set.mockResolvedValue(undefined);
});

describe('quick reply favourites route', () => {
  it('lists the caller favourites, viewers included', async () => {
    h.role = 'viewer';
    expect(await (await GET()).json()).toEqual({ quick_reply_ids: [QR] });
    expect(h.list).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' });
  });

  it('stars and unstars for the session member', async () => {
    const res = await put({ quick_reply_id: QR.toUpperCase(), favourite: true });
    expect(await res.json()).toEqual({ quick_reply_id: QR, favourite: true });
    expect(h.set).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, QR, true);
    await put({ quick_reply_id: QR, favourite: false });
    expect(h.set).toHaveBeenLastCalledWith(expect.anything(), QR, false);
  });

  it.each([
    [{ quick_reply_id: 'x', favourite: true }],
    [{ quick_reply_id: QR }],
    [{ quick_reply_id: QR, favourite: 'yes' }],
    [null],
  ])('rejects %j', async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('refuses viewers and reports unknown quick replies as 404', async () => {
    h.role = 'viewer';
    expect((await put({ quick_reply_id: QR, favourite: true })).status).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
    h.role = 'agent';
    h.set.mockRejectedValueOnce(new InboxPreferenceError('Missing', 404));
    expect((await put({ quick_reply_id: QR, favourite: true })).status).toBe(404);
  });
});
