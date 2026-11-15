import { describe, expect, it } from 'vitest';
import { MAX_RULES, normaliseTag, parseRules, readStoredRules, RuleError, slugify, isSlug } from './collection-rules';

const CAT = '33333333-3333-4333-8333-333333333333';
const part = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof RuleError ? `${error.index}:${error.part}` : 'other'; }
  return null;
};

describe('collection rules', () => {
  it('accepts every whitelisted field with its operators and value shape', () => {
    expect(parseRules([
      { field: 'tag', op: 'eq', value: '  Gift Set ' },
      { field: 'brand', op: 'neq', value: 'Kumar' },
      { field: 'product_type', op: 'eq', value: 'Oil' },
      { field: 'category', op: 'eq', value: CAT.toUpperCase() },
      { field: 'price', op: 'gt', value: 49900 },
      { field: 'price', op: 'lt', value: 0 },
      { field: 'on_sale', op: 'is', value: true },
    ])).toEqual([
      { field: 'tag', op: 'eq', value: 'gift set' },
      { field: 'brand', op: 'neq', value: 'Kumar' },
      { field: 'product_type', op: 'eq', value: 'Oil' },
      { field: 'category', op: 'eq', value: CAT },
      { field: 'price', op: 'gt', value: 49900 },
      { field: 'price', op: 'lt', value: 0 },
      { field: 'on_sale', op: 'is', value: true },
    ]);
    expect(parseRules(undefined)).toEqual([]);
    expect(parseRules([])).toEqual([]);
  });

  it('refuses unknown fields, operators and wrong value shapes', () => {
    expect(part(() => parseRules([{ field: 'status', op: 'eq', value: 'draft' }]))).toBe('0:field');
    expect(part(() => parseRules([{ field: 'p.name; DROP TABLE x', op: 'eq', value: 'a' }]))).toBe('0:field');
    expect(part(() => parseRules([{ field: '__proto__', op: 'eq', value: 'a' }]))).toBe('0:field');
    expect(part(() => parseRules([{ field: 'tag', op: 'like', value: 'a' }]))).toBe('0:op');
    expect(part(() => parseRules([{ field: 'price', op: 'eq', value: 5 }]))).toBe('0:op');
    expect(part(() => parseRules([{ field: 'tag', op: 'gt', value: 'a' }]))).toBe('0:op');
    expect(part(() => parseRules([{ field: 'price', op: 'gt', value: '100' }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'price', op: 'gt', value: -1 }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'price', op: 'gt', value: 1.5 }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'category', op: 'eq', value: 'not-a-uuid' }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'on_sale', op: 'is', value: 'yes' }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'tag', op: 'eq', value: '' }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'tag', op: 'eq', value: 'a'.repeat(81) }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'brand', op: 'eq', value: 'a\u0000b' }]))).toBe('0:value');
    expect(part(() => parseRules([{ field: 'tag', op: 'eq', value: 'a,b' }]))).toBe('0:value');
    expect(part(() => parseRules(['tag']))).toBe('0:rules');
    expect(part(() => parseRules({ field: 'tag' }))).toBe('null:rules');
  });

  it('caps the number of rules', () => {
    const rule = { field: 'tag', op: 'eq', value: 'a' };
    expect(parseRules(Array.from({ length: MAX_RULES }, () => rule))).toHaveLength(MAX_RULES);
    expect(part(() => parseRules(Array.from({ length: MAX_RULES + 1 }, () => rule)))).toBe('null:rules');
  });

  it('drops unknown keys and keeps injection-looking text as a plain value', () => {
    const [rule] = parseRules([{ field: 'brand', op: 'eq', value: "x' OR 1=1 --", sql: 'DROP TABLE shop_products' }]);
    expect(rule).toEqual({ field: 'brand', op: 'eq', value: "x' OR 1=1 --" });
  });

  it('reads stored rules leniently', () => {
    expect(readStoredRules([{ field: 'tag', op: 'eq', value: 'a' }, { field: 'evil', op: 'eq', value: 'a' }, 5])).toEqual([{ field: 'tag', op: 'eq', value: 'a' }]);
    expect(readStoredRules('nope')).toEqual([]);
  });

  it('normalises tags and slugs', () => {
    expect(normaliseTag('  Summer   SALE ')).toBe('summer sale');
    expect(normaliseTag('')).toBeNull();
    expect(normaliseTag('a,b')).toBeNull();
    expect(normaliseTag('x'.repeat(41))).toBeNull();
    expect(normaliseTag(5)).toBeNull();
    expect(slugify('Summer Sale 2026!')).toBe('summer-sale-2026');
    expect(slugify('Crème brûlée')).toBe('creme-brulee');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(80))).toHaveLength(60);
    expect(isSlug('summer-sale')).toBe(true);
    for (const bad of ['Summer', 'a--b', '-a', 'a-', '', 'a b', 'x'.repeat(61), 5]) expect(isSlug(bad)).toBe(false);
  });
});
