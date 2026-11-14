import { describe, expect, it } from 'vitest';
import { cartCount, cleanCart, MAX_LINES, MAX_QTY } from './cart-store';

const V1 = '0b8c3c3e-8a5e-4d6c-9a52-0f6f2b1d2e3f';
const V2 = '1c9d4d4f-9b6f-4e7d-8b63-1a7a3c2e3f40';

describe('browser cart', () => {
  it('keeps only well-formed lines, merged and clamped', () => {
    expect(cleanCart([
      { variantId: V1, qty: 2 }, { variantId: V1, qty: 98 }, { variantId: V2, qty: 0 }, { variantId: 'x', qty: 1 },
      { variantId: V2, qty: 1.5 }, null, 'junk', { variantId: V2, qty: 3, price: 1 },
    ])).toEqual([{ variantId: V1, qty: MAX_QTY }, { variantId: V2, qty: 3 }]);
    expect(cleanCart({ not: 'an array' })).toEqual([]);
  });

  it('stores at most 50 lines and counts items', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ variantId: `${V1.slice(0, -2)}${String(i).padStart(2, '0')}`, qty: 1 }));
    expect(cleanCart(many)).toHaveLength(MAX_LINES);
    expect(cartCount([{ variantId: V1, qty: 2 }, { variantId: V2, qty: 3 }])).toBe(5);
  });
});
