import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), timeline: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn((error: { status?: number }) => Response.json({ error: 'auth' }, { status: error?.status ?? 500 })),
}));
vi.mock('@/lib/events/timeline', async (original) => ({
  ...(await original<typeof import('@/lib/events/timeline')>()),
  contactTimeline: mocks.timeline,
}));

import { TimelineCursorError } from '@/lib/events/timeline';
import { GET } from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = (role: string) => ({ db: {}, accountId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333', role, account: { id: 'a', name: 'A' } });
const call = (query = '', id = ID) => GET(new Request(`http://localhost/api/contacts/${id}/timeline${query}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('GET /api/contacts/[id]/timeline', () => {
  it('answers any member with the tenant-scoped page and passes the cursor through', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('viewer'));
    mocks.timeline.mockResolvedValue({ events: [], next_cursor: null });
    const res = await call('?cursor=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.timeline).toHaveBeenCalledWith(
      { accountId: ctx('viewer').accountId, userId: ctx('viewer').userId, role: 'viewer' }, ID, 'abc');
  });

  it("is 404 for another workspace's contact and a malformed id, 400 for a bad cursor", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('agent'));
    mocks.timeline.mockResolvedValueOnce(null);
    expect((await call()).status).toBe(404);
    expect((await call('', 'nope')).status).toBe(404);
    mocks.timeline.mockRejectedValueOnce(new TimelineCursorError());
    expect((await call('?cursor=zz')).status).toBe(400);
  });

  it('refuses without a session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(Object.assign(new Error('no'), { status: 401 }));
    expect((await call()).status).toBe(401);
    expect(mocks.timeline).not.toHaveBeenCalled();
  });
});
