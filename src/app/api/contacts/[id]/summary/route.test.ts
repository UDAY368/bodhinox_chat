import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  summary: vi.fn(),
  page: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((error: { status?: number }) => Response.json({ error: 'auth' }, { status: error?.status ?? 500 })),
}));
vi.mock('@/lib/contacts/commerce-summary', () => ({
  contactCommerceSummary: mocks.summary,
  contactPaymentsPage: mocks.page,
}));

import { GET as summaryGET } from './route';
import { GET as paymentsGET } from '../payments/route';

const ID = '11111111-1111-4111-8111-111111111111';
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const ctx = (role: string) => ({ db: {}, accountId: '22222222-2222-4222-8222-222222222222', userId: '33333333-3333-4333-8333-333333333333', role, account: { id: 'a', name: 'A' } });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe('GET /api/contacts/[id]/summary', () => {
  it('answers any member with the tenant-scoped summary', async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('viewer'));
    mocks.summary.mockResolvedValue({ orders: null, payments: null, deals: { count: 0, items: [] } });
    const res = await summaryGET(new Request('http://localhost/x'), params());
    expect(res.status).toBe(200);
    expect(mocks.summary).toHaveBeenCalledWith(
      { accountId: ctx('viewer').accountId, userId: ctx('viewer').userId, role: 'viewer' }, ID);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("is 404 for another workspace's contact and for a malformed id", async () => {
    mocks.getCurrentAccount.mockResolvedValue(ctx('agent'));
    mocks.summary.mockResolvedValue(null);
    expect((await summaryGET(new Request('http://localhost/x'), params())).status).toBe(404);
    expect((await summaryGET(new Request('http://localhost/x'), params('nope'))).status).toBe(404);
    expect(mocks.summary).toHaveBeenCalledTimes(1);
  });

  it('refuses without a session', async () => {
    mocks.getCurrentAccount.mockRejectedValue(Object.assign(new Error('no'), { status: 401 }));
    expect((await summaryGET(new Request('http://localhost/x'), params())).status).toBe(401);
    expect(mocks.summary).not.toHaveBeenCalled();
  });
});

describe('GET /api/contacts/[id]/payments', () => {
  it('requires an agent', async () => {
    mocks.requireRole.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    expect((await paymentsGET(new Request('http://localhost/x?page=0'), params())).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it('pages the tenant-scoped payments and rejects a bad page', async () => {
    mocks.requireRole.mockResolvedValue(ctx('agent'));
    mocks.page.mockResolvedValue({ total: 0, pageSize: 10, payments: [] });
    expect((await paymentsGET(new Request('http://localhost/x?page=2'), params())).status).toBe(200);
    expect(mocks.page).toHaveBeenCalledWith(expect.objectContaining({ role: 'agent' }), ID, 2);
    expect((await paymentsGET(new Request('http://localhost/x?page=-1'), params())).status).toBe(400);
  });

  it("is 404 for another workspace's contact", async () => {
    mocks.requireRole.mockResolvedValue(ctx('owner'));
    mocks.page.mockResolvedValue(null);
    expect((await paymentsGET(new Request('http://localhost/x'), params())).status).toBe(404);
  });
});
