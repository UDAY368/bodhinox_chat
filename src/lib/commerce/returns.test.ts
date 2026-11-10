import { describe, expect, it } from 'vitest';
import { chooseReturnPayment, isUniqueViolation, parseDisposition, parseReturnLines, returnWindowOpen } from './returns';

describe('isUniqueViolation', () => {
  it('recognises the one-refund-per-return index violation however Prisma wraps it', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } })).toBe(true);
    expect(isUniqueViolation({ code: 'P2010', meta: { code: '23503' } })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseReturnLines', () => {
  it('accepts unique items with whole positive quantities', () => {
    expect(parseReturnLines([{ order_item_id: A, qty: 1 }, { order_item_id: B, qty: 2 }])).toEqual([
      { order_item_id: A, qty: 1 }, { order_item_id: B, qty: 2 },
    ]);
  });
  it.each([
    [[]], [null], ['x'], [[{ order_item_id: 'nope', qty: 1 }]], [[{ order_item_id: A, qty: 0 }]], [[{ order_item_id: A, qty: 1.5 }]],
    [[{ order_item_id: A, qty: 1 }, { order_item_id: A, qty: 1 }]], [Array.from({ length: 101 }, () => ({ order_item_id: A, qty: 1 }))],
  ])('refuses %j', (input) => {
    expect(() => parseReturnLines(input)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('parseDisposition', () => {
  const lines = [{ order_item_id: A, qty: 1 }, { order_item_id: B, qty: 1 }];
  it('needs restock or discard for exactly the returned lines', () => {
    expect(parseDisposition({ [A]: 'restock', [B]: 'discard' }, lines)).toEqual({ [A]: 'restock', [B]: 'discard' });
    expect(() => parseDisposition({ [A]: 'restock' }, lines)).toThrow();
    expect(() => parseDisposition({ [A]: 'restock', [B]: 'keep' }, lines)).toThrow();
    expect(() => parseDisposition({ [A]: 'restock', [B]: 'discard', x: 'restock' }, lines)).toThrow();
    expect(() => parseDisposition(null, lines)).toThrow();
  });
});

describe('returnWindowOpen', () => {
  const delivered = new Date('2026-11-01T10:00:00Z');
  const at = (iso: string) => new Date(iso);
  it('is open until the window after delivery ends, inclusive', () => {
    expect(returnWindowOpen(delivered, 7, at('2026-11-08T10:00:00Z'))).toBe(true);
    expect(returnWindowOpen(delivered, 7, at('2026-11-08T10:00:01Z'))).toBe(false);
  });
  it('treats 0 days as no returns once delivered', () => {
    expect(returnWindowOpen(delivered, 0, delivered)).toBe(false);
  });
  it('has not started before delivery (in transit, or coming back)', () => {
    expect(returnWindowOpen(null, 0, at('2030-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('chooseReturnPayment', () => {
  const gateway = (id: string, refundable: number) => ({ id, source: 'razorpay', provider_payment_id: `pay_${id}`, refundable });
  const offline = (id: string, refundable: number) => ({ id, source: 'offline', provider_payment_id: null, refundable });
  it('prefers a Razorpay payment that covers the amount, even when an older offline one does too', () => {
    expect(chooseReturnPayment([offline('a', 50_000), gateway('b', 20_000), gateway('c', 30_000)], 20_000))
      .toEqual({ kind: 'gateway', paymentId: 'c' });
  });
  it('skips an exhausted or too small gateway payment', () => {
    expect(chooseReturnPayment([gateway('a', 0), gateway('b', 5_000), offline('c', 40_000)], 10_000))
      .toEqual({ kind: 'outside', paymentId: 'c' });
  });
  it('reports when no single payment covers the amount, and when nothing is left', () => {
    expect(chooseReturnPayment([gateway('a', 6_000), offline('b', 6_000)], 10_000)).toEqual({ kind: 'exceeds' });
    expect(chooseReturnPayment([gateway('a', 0), offline('b', 0)], 1)).toEqual({ kind: 'none' });
    expect(chooseReturnPayment([], 1)).toEqual({ kind: 'none' });
  });
  it('treats a Razorpay-sourced row without a provider payment id as money held outside', () => {
    expect(chooseReturnPayment([{ id: 'a', source: 'razorpay', provider_payment_id: null, refundable: 9_000 }], 9_000))
      .toEqual({ kind: 'outside', paymentId: 'a' });
  });
});
