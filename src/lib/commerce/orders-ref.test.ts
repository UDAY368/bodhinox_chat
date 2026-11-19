import { describe, expect, it } from 'vitest';
import { orderRefRange } from './orders';

describe('orderRefRange', () => {
  it('turns the on-screen reference into the id range that starts with it', () => {
    expect(orderRefRange('3F2A9C1B')).toEqual({
      gte: '3f2a9c1b-0000-0000-0000-000000000000',
      lte: '3f2a9c1b-ffff-ffff-ffff-ffffffffffff',
    });
    expect(orderRefRange(' #3f2a9c ')).toEqual({
      gte: '3f2a9c00-0000-0000-0000-000000000000',
      lte: '3f2a9cff-ffff-ffff-ffff-ffffffffffff',
    });
  });

  it('accepts a full id, with or without dashes', () => {
    const id = '3f2a9c1b-1234-4abc-8def-0123456789ab';
    expect(orderRefRange(id)).toEqual({ gte: id, lte: id });
    expect(orderRefRange(id.replace(/-/g, '').toUpperCase())).toEqual({ gte: id, lte: id });
  });

  it('ignores short or non-hex text, so names and phone fragments are not read as references', () => {
    for (const q of ['', 'abc', '3f2a9', 'Asha', '3f2a9c1g', "3f2a9c'; --", '0'.repeat(33)]) expect(orderRefRange(q)).toBeNull();
  });
});
