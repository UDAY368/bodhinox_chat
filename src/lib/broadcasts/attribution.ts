/**
 * Campaign sales: the orders and revenue a campaign (broadcast) brought in. The one definition:
 *
 *   An order is attributed to a campaign when the order's contact received that campaign's message
 *   (its broadcast_recipients row was delivered or read: delivered_at, else read_at) in the
 *   ATTRIBUTION_WINDOW_DAYS before the order was placed (orders.created_at), and that campaign is the
 *   latest one the contact received before the order (last touch: ties go to the later recipient row).
 *   Only orders in a paid state count (ATTRIBUTED_ORDER_STATUSES). Revenue is the order total less
 *   what was refunded (never below zero), summed per order currency: amounts in different currencies
 *   are never added together. A fully refunded order still counts as an order, with no revenue.
 *
 * One bounded query for any number of campaigns (the list page asks for its visible page at once).
 * It reads only rows of the caller's account: run it inside withTenant.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

export const ATTRIBUTION_WINDOW_DAYS = 7;
export const ATTRIBUTED_ORDER_STATUSES = ['paid', 'partially_shipped', 'dispatched', 'fulfilled'] as const;
/** The most campaigns one request may ask about (the list page shows 20). */
export const MAX_SALES_CAMPAIGNS = 50;

export interface CampaignSales {
  orders: number;
  /** Net revenue in minor units, one entry per order currency, largest first. */
  revenue: { currency: string; minor: number }[];
}

export async function campaignSales(tx: TenantTransaction, accountId: string, broadcastIds: readonly string[]): Promise<Record<string, CampaignSales>> {
  const ids = [...new Set(broadcastIds)].slice(0, MAX_SALES_CAMPAIGNS);
  const out: Record<string, CampaignSales> = Object.fromEntries(ids.map((id) => [id, { orders: 0, revenue: [] }]));
  if (!ids.length) return out;
  const statuses = [...ATTRIBUTED_ORDER_STATUSES];
  // Candidates: paid orders whose contact received one of these campaigns in the window before the order.
  // Each candidate then goes to the latest campaign of any kind the contact received in its window, so a
  // later campaign outside the requested page still takes the order away from these.
  const rows = await tx.$queryRaw<{ broadcast_id: string; currency: string; orders: number; minor: bigint }[]>`
    WITH candidates AS (
      SELECT DISTINCT o.id, o.contact_id, o.created_at, o.currency,
        greatest(COALESCE(o.total_minor, o.subtotal_minor, 0) - o.amount_refunded_minor, 0) AS net
      FROM broadcast_recipients r
      JOIN orders o ON o.account_id=r.account_id AND o.contact_id=r.contact_id
        AND COALESCE(r.delivered_at, r.read_at) <= o.created_at
        AND COALESCE(r.delivered_at, r.read_at) > o.created_at - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS})
      WHERE r.account_id=${accountId}::uuid AND r.broadcast_id = ANY(${ids}::uuid[]) AND r.contact_id IS NOT NULL
        AND o.status = ANY(${statuses}::text[])
    )
    SELECT w.broadcast_id::text AS broadcast_id, c.currency, count(*)::int AS orders, sum(c.net)::bigint AS minor
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT r.broadcast_id FROM broadcast_recipients r
      WHERE r.account_id=${accountId}::uuid AND r.contact_id=c.contact_id
        AND COALESCE(r.delivered_at, r.read_at) <= c.created_at
        AND COALESCE(r.delivered_at, r.read_at) > c.created_at - make_interval(days => ${ATTRIBUTION_WINDOW_DAYS})
      ORDER BY COALESCE(r.delivered_at, r.read_at) DESC, r.id DESC LIMIT 1
    ) w
    WHERE w.broadcast_id = ANY(${ids}::uuid[])
    GROUP BY w.broadcast_id, c.currency
    ORDER BY w.broadcast_id, minor DESC, c.currency`;
  for (const row of rows) {
    const sales = out[row.broadcast_id];
    if (!sales) continue;
    sales.orders += row.orders;
    sales.revenue.push({ currency: row.currency, minor: Number(row.minor) });
  }
  return out;
}
