import { describe, expect, it } from 'vitest';
import { CatalogueError, parseOptionValues, parseShopProductQuery } from './products';
import { parseAdjustInput, parseInventoryQuery, parseMovementQuery, parseThresholdInput } from './inventory';

const VARIANT = '11111111-1111-4111-8111-111111111111';
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof CatalogueError ? `${e.code}:${e.field ?? ''}` : 'other'; }
  return 'ok';
};

describe('catalogue input parsing', () => {
  it('accepts at most four short option pairs', () => {
    expect(parseOptionValues({ Size: ' M ', Colour: 'Blue' })).toEqual({ Size: 'M', Colour: 'Blue' });
    expect(code(() => parseOptionValues({ a: '1', b: '2', c: '3', d: '4', e: '5' }))).toBe('invalid:option_values');
    expect(code(() => parseOptionValues({ Size: '' }))).toBe('invalid:option_values');
    expect(code(() => parseOptionValues({ Size: 3 }))).toBe('invalid:option_values');
    expect(code(() => parseOptionValues(['M']))).toBe('invalid:option_values');
    expect(code(() => parseOptionValues({ ['x'.repeat(41)]: 'M' }))).toBe('invalid:option_values');
  });

  it('reads the product list query and ignores unknown values', () => {
    expect(parseShopProductQuery(new URLSearchParams('q=%20ash%20&status=published&stock=low&category_id=' + VARIANT + '&limit=500')))
      .toEqual({ q: 'ash', status: 'published', stock: 'low', categoryId: VARIANT, limit: 100, offset: 0 });
    expect(parseShopProductQuery(new URLSearchParams('status=deleted&stock=x&category_id=1&offset=-4')))
      .toEqual({ q: undefined, status: undefined, stock: undefined, categoryId: undefined, limit: 50, offset: 0 });
    expect(parseShopProductQuery(new URLSearchParams('status=all')).status).toBe('all');
  });

  it('reads inventory and movement queries', () => {
    expect(parseInventoryQuery(new URLSearchParams('filter=out&q=ab'))).toMatchObject({ filter: 'out', q: 'ab' });
    expect(parseInventoryQuery(new URLSearchParams('filter=everything')).filter).toBeUndefined();
    const at = '2026-11-03T10:00:00.123456Z';
    expect(parseMovementQuery(new URLSearchParams(`variant_id=${VARIANT}&before=${encodeURIComponent(`${at}|${VARIANT}`)}`)))
      .toEqual({ variantId: VARIANT, before: { createdAt: new Date(at).toISOString(), id: VARIANT }, limit: 50 });
    expect(parseMovementQuery(new URLSearchParams('before=nonsense|x')).before).toBeUndefined();
  });

  it('validates a stock adjustment by kind', () => {
    expect(parseAdjustInput(VARIANT, { kind: 'receipt', delta: 5, expected_on_hand: 0 }))
      .toEqual({ variantId: VARIANT, kind: 'receipt', delta: 5, reason: null, expectedOnHand: 0 });
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'receipt', delta: -1, expected_on_hand: 3 }))).toBe('invalid:delta');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'write_off', delta: 1, expected_on_hand: 3, reason: 'x' }))).toBe('invalid:delta');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'write_off', delta: -1, expected_on_hand: 3 }))).toBe('invalid:reason');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'adjustment', delta: 0, expected_on_hand: 3 }))).toBe('invalid:delta');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'adjustment', delta: 1.5, expected_on_hand: 3 }))).toBe('invalid:delta');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'adjustment', delta: 1 }))).toBe('invalid:expected_on_hand');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'sale', delta: -1, expected_on_hand: 3 }))).toBe('invalid:kind');
    expect(code(() => parseAdjustInput('nope', { kind: 'adjustment', delta: 1, expected_on_hand: 0 }))).toBe('not_found:');
    expect(code(() => parseAdjustInput(VARIANT, { kind: 'adjustment', delta: 1, expected_on_hand: 0, reason: 'x'.repeat(201) })))
      .toBe('invalid:reason');
  });

  it('parses a low-stock threshold: 0..100000 or null for the store default', () => {
    expect(parseThresholdInput(VARIANT, { low_stock_threshold: 3 })).toEqual({ variantId: VARIANT, threshold: 3 });
    expect(parseThresholdInput(VARIANT, { low_stock_threshold: null })).toEqual({ variantId: VARIANT, threshold: null });
    expect(code(() => parseThresholdInput(VARIANT, {}))).toBe('invalid:low_stock_threshold');
    expect(code(() => parseThresholdInput(VARIANT, { low_stock_threshold: -1 }))).toBe('invalid:low_stock_threshold');
    expect(code(() => parseThresholdInput(VARIANT, { low_stock_threshold: 1.5 }))).toBe('invalid:low_stock_threshold');
    expect(code(() => parseThresholdInput('nope', { low_stock_threshold: 1 }))).toBe('not_found:');
  });
});
