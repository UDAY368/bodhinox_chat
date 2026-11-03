import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', limited: false, recordDispatch: vi.fn(), cancelAndRefund: vi.fn() }));

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
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/commerce/order-lifecycle', () => ({ recordDispatch: h.recordDispatch, cancelAndRefund: h.cancelAndRefund }));

import { OrderError } from '@/lib/commerce/orders';
import { StockError } from '@/lib/commerce/stock';
import { RefundError } from '@/lib/payments/refunds';
import { POST as dispatch } from './route';
import { POST as cancelRefund } from '../cancel-refund/route';

const params = () => ({ params: Promise.resolve({ id: ORDER }) });
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.recordDispatch.mockResolvedValue(undefined);
  h.cancelAndRefund.mockResolvedValue({ refundIds: ['r1'], refundedOutside: false });
});

describe('POST /api/commerce/orders/[id]/dispatch', () => {
  it('records the dispatch as the signed-in member', async () => {
    const res = await dispatch(req({ from: 'paid', tracking_note: 'DTDC 1' }), params());
    expect(res.status).toBe(200);
    expect(h.recordDispatch).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, ORDER, { from: 'paid', trackingNote: 'DTDC 1' });
  });

  it('refuses viewers, bad input and the rate limit before doing anything', async () => {
    h.role = 'viewer';
    expect((await dispatch(req({}), params())).status).toBe(403);
    h.role = 'agent';
    expect((await dispatch(req({ from: 'shipped' }), params())).status).toBe(400);
    expect((await dispatch(req({ tracking_note: 5 }), params())).status).toBe(400);
    h.limited = true;
    expect((await dispatch(req({}), params())).status).toBe(429);
    expect(h.recordDispatch).not.toHaveBeenCalled();
  });

  it('maps lifecycle and stock refusals to their codes', async () => {
    h.recordDispatch.mockRejectedValueOnce(new OrderError(409, 'bad_transition', 'x'));
    const res = await dispatch(req({}), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'bad_transition' });
    h.recordDispatch.mockRejectedValueOnce(new StockError('out_of_stock'));
    expect(await (await dispatch(req({}), params())).json()).toMatchObject({ code: 'out_of_stock' });
    h.recordDispatch.mockRejectedValueOnce(new Error('db detail with customer content'));
    const failed = await dispatch(req({}), params());
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('customer');
  });
});

describe('POST /api/commerce/orders/[id]/cancel-refund', () => {
  it('returns the refund ids', async () => {
    const res = await cancelRefund(req({ note: 'changed mind' }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refund_ids: ['r1'], refunded_outside: false });
    expect(h.cancelAndRefund).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), ORDER, { note: 'changed mind', refundedOutside: false });
  });

  it('passes the staff confirmation that offline money went back outside the app only when it is exactly true', async () => {
    await cancelRefund(req({ refunded_outside: 'yes' }), params());
    expect(h.cancelAndRefund).toHaveBeenLastCalledWith(expect.anything(), ORDER, { note: null, refundedOutside: false });
    h.cancelAndRefund.mockResolvedValueOnce({ refundIds: [], refundedOutside: true });
    const res = await cancelRefund(req({ refunded_outside: true }), params());
    expect(h.cancelAndRefund).toHaveBeenLastCalledWith(expect.anything(), ORDER, { note: null, refundedOutside: true });
    expect(await res.json()).toEqual({ refund_ids: [], refunded_outside: true });
  });

  it('maps an unconfirmed offline payment to 409 offline_payment', async () => {
    h.cancelAndRefund.mockRejectedValueOnce(new RefundError('offline_payment'));
    const res = await cancelRefund(req({}), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'offline_payment' });
  });
});
