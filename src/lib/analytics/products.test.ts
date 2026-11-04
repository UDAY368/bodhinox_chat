import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { parseRange } from './range';
import { PRODUCT_STATS_LIMIT, productStats } from './products';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const range = parseRange({ preset: 'last_month' }, 'Asia/Kolkata', new Date('2026-11-03T10:00:00Z'));
const squash = (s: string) => s.replace(/\s+/g, ' ');

function fakeTx(result: unknown[]) {
  const statements: Prisma.Sql[] = [];
  const tx = { $queryRaw: async (sql: Prisma.Sql) => { statements.push(sql); return result; } } as never;
  return { tx, statements };
}

describe('productStats', () => {
  it('reads only the workspace paid-order cohort in the range and caps the list', async () => {
    const { tx, statements } = fakeTx([]);
    expect(await productStats(tx, ACCOUNT, range)).toEqual([]);
    const sql = squash(statements[0].text);
    expect(sql).toMatch(/FROM orders o WHERE o\.account_id=\$\d+::uuid AND o\.paid_at >= \$\d+::timestamptz AND o\.paid_at < \$\d+::timestamptz/);
    expect(sql).toContain("o.status IN ('paid','dispatched','fulfilled','cancelled')");
    expect(sql).toMatch(/JOIN order_items i ON i\.account_id=\$\d+::uuid AND i\.order_id=c\.id/);
    // Refunds are capped at the order's merchandise, as commerceStats does.
    expect(sql).toContain('LEAST(m.amount_refunded_minor, sum(m.merch) OVER w)');
    expect(sql).toMatch(/ORDER BY net DESC, gross DESC, key, currency LIMIT \$\d+/);
    expect(statements[0].values).toEqual(expect.arrayContaining([ACCOUNT, range.from.toISOString(), range.to.toISOString(), PRODUCT_STATS_LIMIT]));
    // No customer columns.
    expect(sql).not.toMatch(/contact_id|customer_|phone|address/);
  });

  it('maps bigint sums to minor-unit numbers', async () => {
    const { tx } = fakeTx([{ key: 'SKU-1', name: 'Oil', currency: 'INR', orders: 2, units: BigInt(3), gross: BigInt(30000), discounts: BigInt(1000), refunds: BigInt(500), net: BigInt(28500) }]);
    expect(await productStats(tx, ACCOUNT, range)).toEqual([
      { key: 'SKU-1', name: 'Oil', currency: 'INR', orders: 2, units: 3, grossMinor: 30000, discountsMinor: 1000, refundsMinor: 500, netMinor: 28500 },
    ]);
  });
});
