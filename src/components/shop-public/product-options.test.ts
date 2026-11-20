import { describe, expect, it } from 'vitest';
import { clampQty, LINE_MAX, pickValue, qtyCap, valueState, variantFor, type OptionVariant } from './product-options';

const v = (id: string, size: string, color: string, inStock: boolean, available: number | null = null): OptionVariant =>
  ({ id, options: { Size: size, Color: color }, inStock, available });
// S/Red in stock, S/Blue sold out, M/Red sold out, M/Blue in stock (3 left); no L/Red.
const variants = [v('a', 'S', 'Red', true), v('b', 'S', 'Blue', false, 0), v('c', 'M', 'Red', false, 0), v('d', 'M', 'Blue', true, 3), v('e', 'L', 'Blue', true)];
const names = ['Size', 'Color'];

describe('product option pickers', () => {
  it('greys out a value with no in-stock variant given the other picks', () => {
    const picked = { Size: 'S', Color: 'Red' };
    expect(valueState(variants, names, picked, 'Color', 'Red')).toBe('in_stock');
    expect(valueState(variants, names, picked, 'Color', 'Blue')).toBe('sold_out');
    expect(valueState(variants, names, picked, 'Size', 'M')).toBe('sold_out');
    expect(valueState(variants, names, picked, 'Size', 'L')).toBe('none');
    expect(valueState(variants, names, { Size: 'M', Color: 'Blue' }, 'Size', 'L')).toBe('in_stock');
  });

  it('always lands on a real variant, preferring one in stock', () => {
    expect(pickValue(variants, names, { Size: 'S', Color: 'Red' }, 'Color', 'Blue')).toEqual({ Size: 'S', Color: 'Blue' });
    expect(pickValue(variants, names, { Size: 'S', Color: 'Red' }, 'Size', 'L')).toEqual({ Size: 'L', Color: 'Blue' });
    expect(variantFor(variants, names, { Size: 'M', Color: 'Blue' })?.id).toBe('d');
    expect(variantFor(variants, names, { Size: 'L', Color: 'Red' })).toBeNull();
  });

  it('caps the quantity at the stock left and the line limit', () => {
    expect(qtyCap(null)).toBe(LINE_MAX);
    expect(qtyCap(3)).toBe(3);
    expect(qtyCap(500)).toBe(LINE_MAX);
    expect(qtyCap(-2)).toBe(0);
    expect(clampQty(5, 3)).toBe(3);
    expect(clampQty(0, 3)).toBe(1);
    expect(clampQty(2, 0)).toBe(0);
  });
});
