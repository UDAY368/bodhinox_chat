import { describe, expect, it } from 'vitest';
import { isUniqueViolation, parseDisposition, parseReturnLines } from './returns';

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
