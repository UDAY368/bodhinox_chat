import { describe, expect, it } from 'vitest';
import { AudienceFilterError, compileAudienceFilter, parseAudienceFilter } from './filter';

const account = '00000000-0000-4000-8000-0000000000aa';
const product = '00000000-0000-4000-8000-000000000001';
const category = '00000000-0000-4000-8000-000000000002';

const sqlOf = (condition: unknown) => compileAudienceFilter(account, parseAudienceFilter({ conditions: [condition] }));

describe('shop segment conditions (store plan Phase 8, batch 6)', () => {
  it('accepts order count, spend, order dates and purchases', () => {
    const filter = parseAudienceFilter({
      conditions: [
        { field: 'shop_orders', op: 'at_least', value: 3 },
        { field: 'shop_spend', op: 'at_most', value: 500_000 },
        { field: 'shop_order_date', which: 'last', op: 'before', value: '2026-06-01' },
        { field: 'shop_order_date', which: 'first', op: 'after', value: '2026-01-01' },
        { field: 'shop_bought', op: 'bought', productId: product },
        { field: 'shop_bought', op: 'not_bought', categoryId: category },
      ],
    });
    expect(filter.conditions).toHaveLength(6);
  });

  it.each<[string, unknown]>([
    ['a negative count', { field: 'shop_orders', op: 'at_least', value: -1 }],
    ['a fractional count', { field: 'shop_orders', op: 'at_least', value: 1.5 }],
    ['a count that is text', { field: 'shop_orders', op: 'at_least', value: '3' }],
    ['spend above the cap', { field: 'shop_spend', op: 'at_least', value: 100_000_000_001 }],
    ['an unknown operator', { field: 'shop_spend', op: 'equals', value: 1 }],
    ['a date that is not a date', { field: 'shop_order_date', which: 'last', op: 'before', value: 'yesterday' }],
    ['an unknown order edge', { field: 'shop_order_date', which: 'middle', op: 'before', value: '2026-01-01' }],
    ['a purchase naming neither a product nor a category', { field: 'shop_bought', op: 'bought' }],
    ['a purchase naming both', { field: 'shop_bought', op: 'bought', productId: product, categoryId: category }],
    ['a product that is not an id', { field: 'shop_bought', op: 'bought', productId: 'shoes' }],
    ['an extra field', { field: 'shop_orders', op: 'at_least', value: 1, table: 'orders' }],
  ])('refuses %s', (_label, condition) => {
    expect(() => parseAudienceFilter({ conditions: [condition] })).toThrow(AudienceFilterError);
  });

  it('counts only paid orders that were not cancelled, always inside the account, with every value bound', () => {
    const count = sqlOf({ field: 'shop_orders', op: 'at_least', value: 3 });
    expect(count.sql).toContain('o.account_id=');
    expect(count.sql).toContain('o.paid_at IS NOT NULL');
    expect(count.sql).toContain("o.status NOT IN ('cancelled','expired')");
    expect(count.sql).toContain('>=');
    expect(count.values).toEqual(expect.arrayContaining([account, 3]));
    expect(sqlOf({ field: 'shop_orders', op: 'at_most', value: 0 }).sql).toContain('<=');
    // The top-level scope is still the account.
    expect(count.sql.startsWith('c.account_id=')).toBe(true);
  });

  it('works out spend net of refunds and dates from the first or last order', () => {
    const spend = sqlOf({ field: 'shop_spend', op: 'at_least', value: 100_000 });
    expect(spend.sql).toContain('o.amount_refunded_minor');
    expect(spend.sql).toContain('COALESCE(');
    const last = sqlOf({ field: 'shop_order_date', which: 'last', op: 'before', value: '2026-06-01' });
    expect(last.sql).toContain('max(o.created_at)');
    expect(last.values).toContain('2026-06-01');
    expect(sqlOf({ field: 'shop_order_date', which: 'first', op: 'after', value: '2026-06-01' }).sql).toContain('min(o.created_at)');
  });

  it('matches a purchase through the order lines, ignoring free gifts, and negates only not_bought', () => {
    const bought = sqlOf({ field: 'shop_bought', op: 'bought', productId: product });
    expect(bought.sql).toContain('NOT i.is_gift');
    expect(bought.sql).toContain('p.id=');
    expect(bought.sql).not.toContain('NOT EXISTS');
    expect(bought.values).toContain(product);
    const never = sqlOf({ field: 'shop_bought', op: 'not_bought', categoryId: category });
    expect(never.sql).toContain('NOT EXISTS');
    expect(never.sql).toContain('p.category_id=');
  });

  it('combines with the existing conditions under "any" without leaving the account', () => {
    const filter = parseAudienceFilter({ match: 'any', conditions: [{ field: 'shop_orders', op: 'at_least', value: 1 }, { field: 'name', op: 'is_not_empty' }] });
    const sql = compileAudienceFilter(account, filter);
    expect(sql.sql.startsWith('c.account_id=')).toBe(true);
    expect(sql.sql).toContain(' OR ');
  });
});
