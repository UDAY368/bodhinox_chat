/**
 * Shop reports (store plan Phase 8, batch 7): sales by product, day and channel; the GST report; stock value. Read-only SQL
 * aggregates inside the caller's tenant transaction (analytics runs them with a statement timeout and a range of at most 366 days).
 * Amounts are integer minor units per currency; no customer data.
 *
 * Sales cohort: the same as the analytics Revenue card: orders whose paid_at (set only by settlement) falls in the range and whose
 * status is paid, partially shipped, dispatched, fulfilled or cancelled. Net = merchandise after discounts and without the tax of a tax-inclusive price, less
 * the order's processed refunds capped at its merchandise (the order's amount_refunded_minor). By day and by channel use the order's
 * snapshot, so their totals equal the Revenue card's net merchandise. By product uses the order's lines (line total less line tax) and
 * spreads the order's refund over its lines cumulatively, so the products add up to the same refund to the minor unit.
 *
 * GST: read from the receipts and credit notes the store already issued (commerce_documents). Nothing is re-priced or re-split here
 * except to put the stored per-line tax under its CGST/SGST/IGST heading with the same rule the receipt used (an intra-state receipt:
 * SGST is half the tax rounded down, CGST the rest; inter-state: all IGST). The monthly totals are the stored document figures.
 * Credit notes carry no rate, so they are one line per month (negative).
 *
 * Stock value: on hand x the unit cost of the newest purchase order line that has received stock for the variant (batch 2); there is no
 * product cost field. Variants with stock and no such cost are listed apart and not valued.
 */
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AnalyticsRange } from '@/lib/analytics/range';
import { minorFromDb, minorToDecimalString } from './money';
import { csvCell } from './order-export';

const n = (value: bigint | number | string | null | undefined): number => minorFromDb(value) ?? 0;
const from = (range: AnalyticsRange) => Prisma.sql`${range.from.toISOString()}::timestamptz`;
const to = (range: AnalyticsRange) => Prisma.sql`${range.to.toISOString()}::timestamptz`;

export const REPORT_PRODUCT_ROWS = 100;
export const STOCK_ROWS = 200;
/** Variants read for the totals; a catalogue past this is cut (flagged as truncated). */
export const STOCK_SCAN_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Sales

export interface SalesProductRow { key: string; name: string; currency: string; units: number; grossMinor: number; refundsMinor: number; netMinor: number }
export interface SalesDayRow { day: string; currency: string; orders: number; netMinor: number }
export interface SalesChannelRow { channel: string; currency: string; orders: number; netMinor: number }
export interface SalesReport {
  byProduct: SalesProductRow[];
  /** More products sold than the rows shown. */
  productsTruncated: boolean;
  byDay: SalesDayRow[];
  byChannel: SalesChannelRow[];
}

const COHORT_STATUS = Prisma.sql`o.status IN ('paid','partially_shipped','dispatched','fulfilled','cancelled')`;

export async function salesReport(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<SalesReport> {
  const byDay = await tx.$queryRaw<{ day: string; currency: string; orders: number; net: bigint }[]>(Prisma.sql`
    WITH cohort AS (
      SELECT o.currency, o.paid_at,
        GREATEST(o.subtotal_minor - o.discount_minor - CASE WHEN o.tax_inclusive THEN COALESCE((
          SELECT sum(i.tax_minor) FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id), 0) ELSE 0 END, 0) AS merch,
        o.amount_refunded_minor AS refunded
      FROM orders o
      WHERE o.account_id=${accountId}::uuid AND o.paid_at >= ${from(range)} AND o.paid_at < ${to(range)} AND ${COHORT_STATUS})
    SELECT (paid_at AT TIME ZONE ${range.timezone})::date::text AS day, currency, count(*)::int AS orders,
      sum(merch - LEAST(refunded, merch))::bigint AS net
    FROM cohort GROUP BY 1, 2 ORDER BY 1, 2`);

  const byChannel = await tx.$queryRaw<{ channel: string; currency: string; orders: number; net: bigint }[]>(Prisma.sql`
    WITH cohort AS (
      SELECT o.currency, o.source,
        GREATEST(o.subtotal_minor - o.discount_minor - CASE WHEN o.tax_inclusive THEN COALESCE((
          SELECT sum(i.tax_minor) FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id), 0) ELSE 0 END, 0) AS merch,
        o.amount_refunded_minor AS refunded
      FROM orders o
      WHERE o.account_id=${accountId}::uuid AND o.paid_at >= ${from(range)} AND o.paid_at < ${to(range)} AND ${COHORT_STATUS})
    SELECT source AS channel, currency, count(*)::int AS orders, sum(merch - LEAST(refunded, merch))::bigint AS net
    FROM cohort GROUP BY 1, 2 ORDER BY 4 DESC, 1`);

  // Per line: its value (line total less its tax), the order's value and the refund the order is credited (capped at its value). The
  // refund is shared out cumulatively over the lines in id order: floor(R * running / total) minus the same for the line before.
  const byProduct = await tx.$queryRaw<{ key: string; name: string; currency: string; units: bigint; gross: bigint; refunds: bigint }[]>(Prisma.sql`
    WITH lines AS (
      SELECT i.order_id, i.id, o.currency, i.quantity, i.variant_id, i.retailer_id, i.name, i.sku,
        GREATEST(COALESCE(i.line_total_minor, i.unit_price_minor * i.quantity) - COALESCE(i.tax_minor, 0), 0) AS value,
        o.amount_refunded_minor AS refunded
      FROM orders o JOIN order_items i ON i.account_id=o.account_id AND i.order_id=o.id
      WHERE o.account_id=${accountId}::uuid AND o.paid_at >= ${from(range)} AND o.paid_at < ${to(range)} AND ${COHORT_STATUS}),
    running AS (
      SELECT *, sum(value) OVER (PARTITION BY order_id) AS total,
        sum(value) OVER (PARTITION BY order_id ORDER BY id) AS upto
      FROM lines),
    shared AS (
      SELECT *, CASE WHEN total > 0 THEN
          floor(LEAST(refunded, total)::numeric * upto / total) - floor(LEAST(refunded, total)::numeric * (upto - value) / total)
        ELSE 0 END AS refund
      FROM running)
    SELECT COALESCE(p.id::text, CASE WHEN s.retailer_id IS NOT NULL THEN 'r:' || s.retailer_id ELSE 'n:' || COALESCE(s.name, '') END) AS key,
      COALESCE(p.name, s.name, s.sku, s.retailer_id, '-') AS name, s.currency, sum(s.quantity)::bigint AS units,
      sum(s.value)::bigint AS gross, sum(s.refund)::bigint AS refunds
    FROM shared s
    LEFT JOIN shop_variants v ON v.account_id=${accountId}::uuid AND v.id=s.variant_id
    LEFT JOIN shop_products p ON p.account_id=${accountId}::uuid AND p.id=v.product_id
    GROUP BY 1, 2, 3
    ORDER BY sum(s.value) - sum(s.refund) DESC, 2
    LIMIT ${REPORT_PRODUCT_ROWS + 1}`);

  return {
    byProduct: byProduct.slice(0, REPORT_PRODUCT_ROWS).map((r) => ({
      key: r.key, name: r.name.slice(0, 200), currency: r.currency, units: n(r.units), grossMinor: n(r.gross), refundsMinor: n(r.refunds),
      netMinor: n(r.gross) - n(r.refunds),
    })),
    productsTruncated: byProduct.length > REPORT_PRODUCT_ROWS,
    byDay: byDay.map((r) => ({ day: r.day, currency: r.currency, orders: r.orders, netMinor: n(r.net) })),
    byChannel: byChannel.map((r) => ({ channel: r.channel, currency: r.currency, orders: r.orders, netMinor: n(r.net) })),
  };
}

// ---------------------------------------------------------------------------
// GST

export interface TaxRateRow {
  month: string; currency: string;
  /** Null: lines that carry no rate (an appointment receipt, an unpriced legacy order). */
  rateBps: number | null;
  taxableMinor: number; taxMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number;
}
export interface TaxMonthRow {
  month: string; currency: string;
  receipts: number; taxMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number;
  creditNotes: number; creditTaxableMinor: number; creditTaxMinor: number; creditCgstMinor: number; creditSgstMinor: number; creditIgstMinor: number;
}
export interface TaxReport { rates: TaxRateRow[]; months: TaxMonthRow[] }

export async function taxReport(tx: TenantTransaction, accountId: string, range: AnalyticsRange): Promise<TaxReport> {
  const rates = await tx.$queryRaw<{ month: string; currency: string; bps: number | null; taxable: bigint; tax: bigint; cgst: bigint; sgst: bigint; igst: bigint }[]>(Prisma.sql`
    SELECT to_char(d.issued_at AT TIME ZONE ${range.timezone}, 'YYYY-MM') AS month, d.currency, l.tax_rate_bps AS bps,
      sum(GREATEST(COALESCE(l.line_total_minor, 0) - COALESCE(l.tax_minor, 0), 0))::bigint AS taxable,
      sum(COALESCE(l.tax_minor, 0))::bigint AS tax,
      sum(CASE WHEN d.igst_minor = 0 AND d.cgst_minor + d.sgst_minor > 0 THEN COALESCE(l.tax_minor, 0) - COALESCE(l.tax_minor, 0) / 2 ELSE 0 END)::bigint AS cgst,
      sum(CASE WHEN d.igst_minor = 0 AND d.cgst_minor + d.sgst_minor > 0 THEN COALESCE(l.tax_minor, 0) / 2 ELSE 0 END)::bigint AS sgst,
      sum(CASE WHEN d.igst_minor > 0 THEN COALESCE(l.tax_minor, 0) ELSE 0 END)::bigint AS igst
    FROM commerce_documents d
    CROSS JOIN LATERAL jsonb_to_recordset(d.line_items) AS l(tax_rate_bps int, tax_minor bigint, line_total_minor bigint)
    WHERE d.account_id=${accountId}::uuid AND d.kind='receipt' AND d.issued_at >= ${from(range)} AND d.issued_at < ${to(range)}
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3 NULLS FIRST`);

  const months = await tx.$queryRaw<{ month: string; currency: string; receipts: number; tax: bigint; cgst: bigint; sgst: bigint; igst: bigint;
    notes: number; note_taxable: bigint; note_tax: bigint; note_cgst: bigint; note_sgst: bigint; note_igst: bigint }[]>(Prisma.sql`
    SELECT to_char(issued_at AT TIME ZONE ${range.timezone}, 'YYYY-MM') AS month, currency,
      (count(*) FILTER (WHERE kind='receipt'))::int AS receipts,
      COALESCE(sum(tax_minor) FILTER (WHERE kind='receipt'), 0)::bigint AS tax,
      COALESCE(sum(cgst_minor) FILTER (WHERE kind='receipt'), 0)::bigint AS cgst,
      COALESCE(sum(sgst_minor) FILTER (WHERE kind='receipt'), 0)::bigint AS sgst,
      COALESCE(sum(igst_minor) FILTER (WHERE kind='receipt'), 0)::bigint AS igst,
      (count(*) FILTER (WHERE kind='credit_note'))::int AS notes,
      COALESCE(sum(subtotal_minor) FILTER (WHERE kind='credit_note'), 0)::bigint AS note_taxable,
      COALESCE(sum(tax_minor) FILTER (WHERE kind='credit_note'), 0)::bigint AS note_tax,
      COALESCE(sum(cgst_minor) FILTER (WHERE kind='credit_note'), 0)::bigint AS note_cgst,
      COALESCE(sum(sgst_minor) FILTER (WHERE kind='credit_note'), 0)::bigint AS note_sgst,
      COALESCE(sum(igst_minor) FILTER (WHERE kind='credit_note'), 0)::bigint AS note_igst
    FROM commerce_documents
    WHERE account_id=${accountId}::uuid AND issued_at >= ${from(range)} AND issued_at < ${to(range)}
    GROUP BY 1, 2 ORDER BY 1, 2`);

  return {
    rates: rates.map((r) => ({ month: r.month, currency: r.currency, rateBps: r.bps, taxableMinor: n(r.taxable), taxMinor: n(r.tax), cgstMinor: n(r.cgst),
      sgstMinor: n(r.sgst), igstMinor: n(r.igst) })),
    months: months.map((m) => ({ month: m.month, currency: m.currency, receipts: m.receipts, taxMinor: n(m.tax), cgstMinor: n(m.cgst), sgstMinor: n(m.sgst),
      igstMinor: n(m.igst), creditNotes: m.notes, creditTaxableMinor: n(m.note_taxable), creditTaxMinor: n(m.note_tax), creditCgstMinor: n(m.note_cgst),
      creditSgstMinor: n(m.note_sgst), creditIgstMinor: n(m.note_igst) })),
  };
}

/** A number is written as is (a negative credit stays a number); any text goes through the orders export's formula guard. */
const taxCell = (value: string | number): string => (typeof value === 'number' && Number.isFinite(value) ? `"${value}"` : csvCell(String(value)));
const csvRow = (cells: ReadonlyArray<string | number>): string => cells.map(taxCell).join(',');

export const TAX_CSV_HEADER = ['section', 'month', 'currency', 'rate_percent', 'taxable', 'tax', 'cgst', 'sgst', 'igst', 'documents'] as const;

/** "5" for 500 bps, "2.5" for 250; empty without a rate. */
export const ratePercent = (bps: number | null): string => (bps === null ? '' : String(bps / 100));

/**
 * The GST report as CSV (text cells formula-guarded with the orders export's helper; amounts are plain numbers): one row per month and rate for receipts, one
 * row per month for credit notes (amounts negative, they reverse supply), and one row per month with the stored document totals.
 */
export function taxReportCsv(report: TaxReport): string {
  // Money goes out as a number (not text), so a negative credit is a number in the spreadsheet and not a guarded string.
  const m = (v: number, currency: string) => Number(minorToDecimalString(v, currency));
  const lines = [csvRow(TAX_CSV_HEADER)];
  for (const r of report.rates) {
    lines.push(csvRow(['sales_by_rate', r.month, r.currency, ratePercent(r.rateBps), m(r.taxableMinor, r.currency), m(r.taxMinor, r.currency),
      m(r.cgstMinor, r.currency), m(r.sgstMinor, r.currency), m(r.igstMinor, r.currency), '']));
  }
  for (const t of report.months) {
    if (t.creditNotes > 0) {
      lines.push(csvRow(['credit_notes', t.month, t.currency, '', m(-t.creditTaxableMinor, t.currency), m(-t.creditTaxMinor, t.currency),
        m(-t.creditCgstMinor, t.currency), m(-t.creditSgstMinor, t.currency), m(-t.creditIgstMinor, t.currency), t.creditNotes]));
    }
    lines.push(csvRow(['receipt_totals', t.month, t.currency, '', '', m(t.taxMinor, t.currency), m(t.cgstMinor, t.currency), m(t.sgstMinor, t.currency),
      m(t.igstMinor, t.currency), t.receipts]));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// Stock value

export interface StockCostedRow { variantId: string; sku: string; name: string; onHand: number; unitCostMinor: number; valueMinor: number; currency: string }
export interface StockUncostedRow { variantId: string; sku: string; name: string; onHand: number }
export interface StockValueReport {
  /** Value per currency (the purchase order's currency). */
  totals: Array<{ currency: string; units: number; valueMinor: number }>;
  costed: StockCostedRow[];
  noCost: StockUncostedRow[];
  /** More variants than the rows shown, in either list. */
  truncated: boolean;
}

export async function stockValueReport(tx: TenantTransaction, accountId: string): Promise<StockValueReport> {
  const rows = await tx.$queryRaw<{ variant_id: string; sku: string; name: string; on_hand: number; unit_cost: bigint | null; currency: string | null }[]>`
    WITH cost AS (
      SELECT DISTINCT ON (pl.variant_id) pl.variant_id, pl.unit_cost_minor, po.currency
      FROM purchase_order_lines pl
      JOIN purchase_orders po ON po.account_id=pl.account_id AND po.id=pl.purchase_order_id
      WHERE pl.account_id=${accountId}::uuid AND pl.qty_received > 0 AND pl.unit_cost_minor > 0 AND po.status <> 'cancelled'
      ORDER BY pl.variant_id, COALESCE(po.ordered_at, po.created_at) DESC, pl.id DESC)
    SELECT v.id::text AS variant_id, v.sku, p.name, il.on_hand, c.unit_cost_minor AS unit_cost, c.currency
    FROM inventory_levels il
    JOIN shop_variants v ON v.account_id=il.account_id AND v.id=il.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN cost c ON c.variant_id=v.id
    WHERE il.account_id=${accountId}::uuid AND il.on_hand > 0 AND v.archived_at IS NULL AND v.track_inventory
    ORDER BY il.on_hand::numeric * COALESCE(c.unit_cost_minor, 0) DESC, p.name, v.sku
    LIMIT ${STOCK_SCAN_LIMIT}`;
  const totals = new Map<string, { currency: string; units: number; valueMinor: number }>();
  const costed: StockCostedRow[] = [];
  const noCost: StockUncostedRow[] = [];
  let truncated = rows.length >= STOCK_SCAN_LIMIT;
  for (const r of rows) {
    const cost = minorFromDb(r.unit_cost);
    if (cost && r.currency) {
      const value = cost * r.on_hand;
      const t = totals.get(r.currency) ?? { currency: r.currency, units: 0, valueMinor: 0 };
      t.units += r.on_hand;
      t.valueMinor += value;
      totals.set(r.currency, t);
      if (costed.length < STOCK_ROWS) costed.push({ variantId: r.variant_id, sku: r.sku, name: r.name.slice(0, 200), onHand: r.on_hand, unitCostMinor: cost, valueMinor: value, currency: r.currency });
      else truncated = true;
    } else if (noCost.length < STOCK_ROWS) noCost.push({ variantId: r.variant_id, sku: r.sku, name: r.name.slice(0, 200), onHand: r.on_hand });
    else truncated = true;
  }
  return { totals: [...totals.values()].sort((a, b) => b.valueMinor - a.valueMinor), costed, noCost, truncated };
}
