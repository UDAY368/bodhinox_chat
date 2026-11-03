/**
 * Commerce revenue for the analytics page (Phase 8, design section 3
 * "Revenue", PRD money metrics :204-208). Read-only aggregates over the
 * tenant's own rows, per currency, in integer minor units:
 *
 * - Order cohort: verified paid orders, i.e. orders whose paid_at (set only by
 *   settlement after an authoritative fetch, never by staff or a success
 *   page) falls in the range. Later refunds restate that cohort.
 *   - gross merchandise = sum of subtotal_minor (item amounts before
 *     discounts and refunds; tax-inclusive when the store's prices are);
 *   - discounts, tax and shipping are reported separately;
 *   - net merchandise = per order (subtotal - discount - item tax when prices
 *     include tax), less that order's processed refunds capped at its
 *     merchandise (refunds are not split into tax and shipping parts);
 *   - average order value = net merchandise / paid orders.
 * - Money ledger: captured customer_payments by captured_at (gateway and
 *   staff-recorded offline separately; payments for appointments and plain
 *   links included), processed customer_refunds by processed_at (Bodhinox and
 *   external dashboard refunds), and net collections = collected - refunds.
 *
 * Nothing here returns customer data: amounts, counts and currency codes.
 */
import { Prisma } from '@prisma/client';
import { minorFromDb } from '@/lib/commerce/money';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from './range';

export interface CommerceCurrencyStats {
  currency: string;
  paidOrders: number;
  grossMerchandiseMinor: number;
  discountsMinor: number;
  taxMinor: number;
  shippingMinor: number;
  /** Processed refunds of cohort orders, capped per order at its merchandise. */
  merchandiseRefundsMinor: number;
  netMerchandiseMinor: number;
  /** Net merchandise / paid orders, rounded half up; null without paid orders. */
  averageOrderValueMinor: number | null;
  collectedMinor: number;
  gatewayCollectedMinor: number;
  offlineCollectedMinor: number;
  refundsMinor: number;
  /** The part of refundsMinor made in the Razorpay dashboard. */
  externalRefundsMinor: number;
  netCollectedMinor: number;
}

export interface CommerceDay {
  /** YYYY-MM-DD in the workspace timezone. */
  day: string;
  currency: string;
  collectedMinor: number;
  refundsMinor: number;
}

export interface CommerceStats {
  currencies: CommerceCurrencyStats[];
  /** Per local day and currency: captured and refunded amounts (the reconciliation view of the ledger). */
  daily: CommerceDay[];
}

const n = (value: bigint | number | string | null | undefined): number => minorFromDb(value) ?? 0;
const from = (range: AnalyticsRange) => Prisma.sql`${range.from.toISOString()}::timestamptz`;
const to = (range: AnalyticsRange) => Prisma.sql`${range.to.toISOString()}::timestamptz`;

function blank(currency: string): CommerceCurrencyStats {
  return {
    currency, paidOrders: 0, grossMerchandiseMinor: 0, discountsMinor: 0, taxMinor: 0, shippingMinor: 0, merchandiseRefundsMinor: 0,
    netMerchandiseMinor: 0, averageOrderValueMinor: null, collectedMinor: 0, gatewayCollectedMinor: 0, offlineCollectedMinor: 0,
    refundsMinor: 0, externalRefundsMinor: 0, netCollectedMinor: 0,
  };
}

/** Half-up integer division for non-negative amounts. */
function divHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export async function commerceStats(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<CommerceStats> {
  const orders = await tx.$queryRaw<{ currency: string; orders: number; gross: bigint; discounts: bigint; tax: bigint; shipping: bigint;
    refunds: bigint; net: bigint }[]>(Prisma.sql`
    WITH cohort AS (
      SELECT o.currency, o.subtotal_minor, o.discount_minor, o.tax_minor, o.shipping_minor,
        GREATEST(o.subtotal_minor - o.discount_minor - CASE WHEN o.tax_inclusive THEN COALESCE((
          SELECT sum(i.tax_minor) FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id), 0) ELSE 0 END, 0) AS merch,
        -- Only refunds of money credited to the order (settled payments) count; applyRefundStateTx keeps this total.
        -- A refund of a duplicate or other exception payment carries the order_id but never touched its merchandise.
        o.amount_refunded_minor AS refunded
      FROM orders o
      WHERE o.account_id=${accountId}::uuid AND o.paid_at >= ${from(range)} AND o.paid_at < ${to(range)}
        AND o.status IN ('paid','dispatched','fulfilled','cancelled')
    )
    SELECT currency, count(*)::int AS orders, sum(subtotal_minor)::bigint AS gross, sum(discount_minor)::bigint AS discounts,
      sum(tax_minor)::bigint AS tax, sum(shipping_minor)::bigint AS shipping, sum(LEAST(refunded, merch))::bigint AS refunds,
      sum(merch - LEAST(refunded, merch))::bigint AS net
    FROM cohort GROUP BY currency`);

  const payments = await tx.$queryRaw<{ currency: string; gateway: bigint; offline: bigint }[]>(Prisma.sql`
    SELECT currency, COALESCE(sum(amount_minor) FILTER (WHERE source='razorpay'), 0)::bigint AS gateway,
      COALESCE(sum(amount_minor) FILTER (WHERE source='offline'), 0)::bigint AS offline
    FROM customer_payments
    WHERE account_id=${accountId}::uuid AND status='captured' AND captured_at >= ${from(range)} AND captured_at < ${to(range)}
    GROUP BY currency`);

  const refunds = await tx.$queryRaw<{ currency: string; total: bigint; external: bigint }[]>(Prisma.sql`
    SELECT currency, sum(amount_minor)::bigint AS total, COALESCE(sum(amount_minor) FILTER (WHERE source='external'), 0)::bigint AS external
    FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND status='processed'
      AND COALESCE(processed_at, updated_at) >= ${from(range)} AND COALESCE(processed_at, updated_at) < ${to(range)}
    GROUP BY currency`);

  const daily = await tx.$queryRaw<{ day: string; currency: string; collected: bigint; refunds: bigint }[]>(Prisma.sql`
    WITH ledger AS (
      SELECT (captured_at AT TIME ZONE ${range.timezone})::date AS day, currency, amount_minor AS collected, 0::bigint AS refunds
      FROM customer_payments
      WHERE account_id=${accountId}::uuid AND status='captured' AND captured_at >= ${from(range)} AND captured_at < ${to(range)}
      UNION ALL
      SELECT (COALESCE(processed_at, updated_at) AT TIME ZONE ${range.timezone})::date, currency, 0::bigint, amount_minor
      FROM customer_refunds
      WHERE account_id=${accountId}::uuid AND status='processed'
        AND COALESCE(processed_at, updated_at) >= ${from(range)} AND COALESCE(processed_at, updated_at) < ${to(range)}
    )
    SELECT day::text AS day, currency, sum(collected)::bigint AS collected, sum(refunds)::bigint AS refunds
    FROM ledger GROUP BY day, currency ORDER BY day, currency`);

  const byCurrency = new Map<string, CommerceCurrencyStats>();
  const get = (currency: string) => {
    const row = byCurrency.get(currency) ?? blank(currency);
    byCurrency.set(currency, row);
    return row;
  };
  for (const o of orders) {
    const row = get(o.currency);
    row.paidOrders = o.orders;
    row.grossMerchandiseMinor = n(o.gross);
    row.discountsMinor = n(o.discounts);
    row.taxMinor = n(o.tax);
    row.shippingMinor = n(o.shipping);
    row.merchandiseRefundsMinor = n(o.refunds);
    row.netMerchandiseMinor = n(o.net);
    row.averageOrderValueMinor = o.orders > 0 ? divHalfUp(row.netMerchandiseMinor, o.orders) : null;
  }
  for (const p of payments) {
    const row = get(p.currency);
    row.gatewayCollectedMinor = n(p.gateway);
    row.offlineCollectedMinor = n(p.offline);
    row.collectedMinor = row.gatewayCollectedMinor + row.offlineCollectedMinor;
  }
  for (const r of refunds) {
    const row = get(r.currency);
    row.refundsMinor = n(r.total);
    row.externalRefundsMinor = n(r.external);
  }
  for (const row of byCurrency.values()) row.netCollectedMinor = row.collectedMinor - row.refundsMinor;

  return {
    // The busiest currency first (normally the one store currency).
    currencies: [...byCurrency.values()].sort((a, b) => b.collectedMinor - a.collectedMinor || b.grossMerchandiseMinor - a.grossMerchandiseMinor
      || a.currency.localeCompare(b.currency)),
    daily: daily.map((d) => ({ day: d.day, currency: d.currency, collectedMinor: n(d.collected), refundsMinor: n(d.refunds) })),
  };
}
