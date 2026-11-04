/**
 * Per-product sales for the analytics comparison (Phase 12 design §5.2) and
 * the product_summary report. Same cohort as commerceStats (commerce.ts):
 * verified paid orders whose paid_at falls in the range. Per product and
 * currency, in integer minor units:
 *
 * - units = sum of line quantities;
 * - gross = quantity x unit price (before discounts and refunds);
 * - discounts = the order's discount shared across its lines by gross;
 * - refunds = the order's processed refunds of merchandise (capped at its
 *   merchandise, as commerceStats does) shared across its lines by
 *   merchandise; refunds are not itemised, so this is an allocation;
 * - net = line merchandise (gross - discount share - line tax when prices
 *   include tax) - refund share.
 *
 * Shares are computed in numeric and rounded once per product, so a product's
 * figures can differ from the order totals by a minor unit of rounding.
 * order_items is RLS-visible to agents and above only; the route requires
 * agent. Product labels are workspace catalogue names; no customer data.
 */
import { Prisma } from '@prisma/client';
import { minorFromDb } from '@/lib/commerce/money';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from './range';

export const PRODUCT_STATS_LIMIT = 50;

export interface ProductStatsRow {
  /** Stable product key: the catalogue retailer id, SKU, variant id or name. */
  key: string;
  name: string | null;
  currency: string;
  orders: number;
  units: number;
  grossMinor: number;
  discountsMinor: number;
  refundsMinor: number;
  netMinor: number;
}

const n = (value: bigint | number | string | null | undefined): number => minorFromDb(value) ?? 0;

/** The top PRODUCT_STATS_LIMIT products by net revenue (per currency rows) in the range. */
export async function productStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<ProductStatsRow[]> {
  const rows = await tx.$queryRaw<{ key: string; name: string | null; currency: string; orders: number; units: bigint;
    gross: bigint; discounts: bigint; refunds: bigint; net: bigint }[]>(Prisma.sql`
    WITH cohort AS (
      SELECT o.id, o.currency, o.discount_minor, o.tax_inclusive, o.amount_refunded_minor
      FROM orders o
      WHERE o.account_id=${accountId}::uuid AND o.paid_at >= ${range.from.toISOString()}::timestamptz
        AND o.paid_at < ${range.to.toISOString()}::timestamptz
        AND o.status IN ('paid','dispatched','fulfilled','cancelled')
    ), lines AS (
      SELECT c.id AS order_id, c.currency, c.discount_minor, c.tax_inclusive, c.amount_refunded_minor,
        COALESCE(NULLIF(i.retailer_id, ''), NULLIF(i.sku, ''), i.variant_id::text, NULLIF(i.name, ''), '?') AS key,
        i.name, i.quantity, (i.quantity::numeric * i.unit_price_minor) AS gross,
        CASE WHEN c.tax_inclusive THEN COALESCE(i.tax_minor, 0) ELSE 0 END AS inclusive_tax
      FROM cohort c JOIN order_items i ON i.account_id=${accountId}::uuid AND i.order_id=c.id
    ), shared AS (
      SELECT l.*, CASE WHEN sum(l.gross) OVER w > 0 THEN l.discount_minor * l.gross / sum(l.gross) OVER w ELSE 0 END AS discount
      FROM lines l WINDOW w AS (PARTITION BY l.order_id)
    ), merch AS (
      SELECT s.*, GREATEST(s.gross - s.discount - s.inclusive_tax, 0) AS merch FROM shared s
    ), refunded AS (
      SELECT m.*, CASE WHEN sum(m.merch) OVER w > 0
        THEN LEAST(m.amount_refunded_minor, sum(m.merch) OVER w) * m.merch / sum(m.merch) OVER w ELSE 0 END AS refund
      FROM merch m WINDOW w AS (PARTITION BY m.order_id)
    )
    SELECT key, max(name) AS name, currency, count(DISTINCT order_id)::int AS orders, sum(quantity)::bigint AS units,
      round(sum(gross))::bigint AS gross, round(sum(discount))::bigint AS discounts,
      round(sum(refund))::bigint AS refunds, round(sum(merch - refund))::bigint AS net
    FROM refunded GROUP BY key, currency
    ORDER BY net DESC, gross DESC, key, currency
    LIMIT ${PRODUCT_STATS_LIMIT}`);
  return rows.map((r) => ({
    key: r.key, name: r.name, currency: r.currency, orders: r.orders, units: n(r.units),
    grossMinor: n(r.gross), discountsMinor: n(r.discounts), refundsMinor: n(r.refunds), netMinor: n(r.net),
  }));
}
