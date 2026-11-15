import { describe, expect, it } from 'vitest';
import { parseRules } from './collection-rules';
import { parseCollectionInput, ruleSql, rulesWhere } from './collections';
import { CatalogueError, parseDetails, parseTags } from './products';

const CAT = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof CatalogueError ? `${error.code}:${error.field ?? ''}` : 'other'; }
  return null;
};

describe('rules to SQL', () => {
  it('binds every value as a parameter and never writes it into the SQL text', () => {
    const evil = "Kumar'); DROP TABLE shop_products; --";
    const where = rulesWhere(parseRules([
      { field: 'tag', op: 'eq', value: evil },
      { field: 'brand', op: 'neq', value: evil },
      { field: 'product_type', op: 'eq', value: evil },
      { field: 'category', op: 'eq', value: CAT },
      { field: 'price', op: 'gt', value: 100 },
      { field: 'on_sale', op: 'is', value: true },
    ]), 'all');
    expect(where.text).not.toMatch(/DROP|Kumar/i);
    expect(where.text).not.toContain(CAT);
    expect(where.text).toContain('$1');
    // The tag is folded to lower case; the others keep the text as typed. All are values, never SQL.
    expect(where.values).toEqual([evil.toLowerCase(), evil, evil, CAT, CAT, 100]);
  });

  it('compiles each field and operator to its fixed condition', () => {
    const sql = (rule: unknown) => ruleSql(parseRules([rule])[0]).text.replace(/\s+/g, ' ');
    expect(sql({ field: 'tag', op: 'eq', value: 'a' })).toBe('p.tags @> ARRAY[$1]::text[]');
    expect(sql({ field: 'tag', op: 'neq', value: 'a' })).toBe('NOT (p.tags @> ARRAY[$1]::text[])');
    expect(sql({ field: 'brand', op: 'eq', value: 'a' })).toBe('lower(p.brand) = lower($1)');
    expect(sql({ field: 'brand', op: 'neq', value: 'a' })).toContain('NOT COALESCE(lower(p.brand) = lower($1), false)');
    expect(sql({ field: 'product_type', op: 'eq', value: 'a' })).toBe('lower(p.product_type) = lower($1)');
    expect(sql({ field: 'category', op: 'eq', value: CAT })).toContain('c.id=$1::uuid OR c.parent_id=$2::uuid');
    expect(sql({ field: 'price', op: 'gt', value: 5 })).toMatch(/> \$1::bigint$/);
    expect(sql({ field: 'price', op: 'lt', value: 5 })).toMatch(/< \$1::bigint$/);
    expect(sql({ field: 'on_sale', op: 'is', value: true })).toMatch(/^EXISTS .*compare_at_minor > v\.price_minor\)$/);
    expect(sql({ field: 'on_sale', op: 'is', value: false })).toMatch(/^NOT EXISTS/);
  });

  it('joins with AND for all and OR for any; no rules match nothing', () => {
    const rules = parseRules([{ field: 'tag', op: 'eq', value: 'a' }, { field: 'brand', op: 'eq', value: 'b' }]);
    expect(rulesWhere(rules, 'all').text).toContain(') AND (');
    expect(rulesWhere(rules, 'any').text).toContain(') OR (');
    expect(rulesWhere(rules, 'all').text).not.toContain(' OR ');
    expect(rulesWhere([], 'all').text).toBe('false');
    expect(rulesWhere([], 'any').text).toBe('false');
  });

  it('cannot be built from an unknown field: parsing refuses it first', () => {
    expect(() => parseRules([{ field: 'p.id) OR (1=1', op: 'eq', value: 'a' }])).toThrow();
  });
});

describe('collection input', () => {
  it('needs a title, derives the slug and defaults to a hand-picked draft', () => {
    expect(parseCollectionInput({ title: ' Summer Sale ' }, null)).toEqual({
      title: 'Summer Sale', slug: 'summer-sale', description: null, kind: 'manual', rules: [], match: 'all', sort: 'featured', published: false, productIds: [],
    });
    expect(code(() => parseCollectionInput({}, null))).toBe('invalid:title');
    expect(code(() => parseCollectionInput({ title: 'x'.repeat(121) }, null))).toBe('invalid:title');
    expect(code(() => parseCollectionInput({ title: '!!!' }, null))).toBe('invalid:slug');
    expect(code(() => parseCollectionInput({ title: 'A', slug: 'Not A Slug' }, null))).toBe('invalid:slug');
    expect(code(() => parseCollectionInput({ title: 'A', kind: 'sql' }, null))).toBe('invalid:kind');
    expect(code(() => parseCollectionInput({ title: 'A', sort: 'random' }, null))).toBe('invalid:sort');
    expect(code(() => parseCollectionInput({ title: 'A', published: 'yes' }, null))).toBe('invalid:published');
  });

  it('keeps rules only on smart collections and picked products only on manual ones', () => {
    const smart = parseCollectionInput({ title: 'A', kind: 'smart', rules: [{ field: 'tag', op: 'eq', value: 'a' }], product_ids: [PRODUCT] }, null);
    expect(smart.rules).toHaveLength(1);
    expect(smart.productIds).toEqual([]);
    const manual = parseCollectionInput({ title: 'A', kind: 'manual', rules: [{ field: 'tag', op: 'eq', value: 'a' }], product_ids: [PRODUCT, PRODUCT.toUpperCase()] }, null);
    expect(manual.rules).toEqual([]);
    expect(manual.productIds).toEqual([PRODUCT]);
  });

  it('refuses a bad rule or product list with a code and the field, not the value', () => {
    expect(code(() => parseCollectionInput({ title: 'A', kind: 'smart', rules: [{ field: 'x', op: 'eq', value: 1 }] }, null))).toBe('invalid:rules');
    expect(code(() => parseCollectionInput({ title: 'A', product_ids: ['nope'] }, null))).toBe('invalid:product_ids');
    expect(code(() => parseCollectionInput({ title: 'A', product_ids: Array.from({ length: 201 }, () => PRODUCT) }, null))).toBe('invalid:product_ids');
  });
});

describe('product fields', () => {
  it('trims, lower-cases and de-duplicates tags, at most twenty', () => {
    expect(parseTags([' Gift ', 'gift', 'New Arrival'])).toEqual(['gift', 'new arrival']);
    expect(parseTags([])).toEqual([]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(20);
    expect(code(() => parseTags(Array.from({ length: 21 }, (_, i) => `t${i}`)))).toBe('invalid:tags');
    expect(code(() => parseTags(['']))).toBe('invalid:tags');
    expect(code(() => parseTags(['a'.repeat(41)]))).toBe('invalid:tags');
    expect(code(() => parseTags('gift'))).toBe('invalid:tags');
    expect(code(() => parseTags([5]))).toBe('invalid:tags');
  });

  it('keeps detail rows as short plain-text pairs, at most twelve', () => {
    expect(parseDetails([{ label: ' Material ', value: 'Cotton  blend', extra: 1 }])).toEqual([{ label: 'Material', value: 'Cotton blend' }]);
    expect(parseDetails([{ label: 'A', value: '<b>bold</b>' }])).toEqual([{ label: 'A', value: '<b>bold</b>' }]);
    expect(code(() => parseDetails(Array.from({ length: 13 }, () => ({ label: 'a', value: 'b' }))))).toBe('invalid:details');
    expect(code(() => parseDetails([{ label: '', value: 'b' }]))).toBe('invalid:details');
    expect(code(() => parseDetails([{ label: 'a', value: '' }]))).toBe('invalid:details');
    expect(code(() => parseDetails([{ label: 'a'.repeat(41), value: 'b' }]))).toBe('invalid:details');
    expect(code(() => parseDetails([{ label: 'a', value: 'b'.repeat(201) }]))).toBe('invalid:details');
    expect(code(() => parseDetails([{ label: 'a', value: 'b\u0000' }]))).toBe('invalid:details');
    expect(code(() => parseDetails(['a: b']))).toBe('invalid:details');
    expect(code(() => parseDetails({}))).toBe('invalid:details');
  });
});
