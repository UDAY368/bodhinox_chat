/**
 * What the buyer's order page shows about returns (store plan Phase 8, batch 5): whether a request can be opened now, which
 * lines can still be returned (and their replacement choices for an exchange), and the requests already made with where
 * staff have got to. Read only; the request itself is made in buyer-returns.ts. This file imports no storefront code so
 * storefront.ts can build the order view with it.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { loadBuyerSettingsTx } from './buyer-settings';
import { buyerReturnEligibility, lineStandings, type ReturnReason } from './return-rules';

const DEFAULT_RETURN_WINDOW_DAYS = 7;
const EXCHANGE_OPTIONS_PER_LINE = 12;

export interface StorefrontReturnLine {
  id: string;
  name: string;
  /** Units that can still be asked for. */
  remaining: number;
  /** A request is open on this line already. */
  open: boolean;
  /** Other variants of the same product on sale now (an exchange asks for one). */
  exchangeOptions: Array<{ variantId: string; label: string }>;
}

export interface StorefrontReturnRequest {
  id: string;
  status: 'requested' | 'received' | 'inspected' | 'closed' | 'rejected';
  /** Staff have not approved it yet. */
  pendingApproval: boolean;
  reason: ReturnReason | null;
  exchange: boolean;
  lines: Array<{ name: string; qty: number }>;
  createdAt: string;
}

export interface StorefrontReturns {
  /** A new request may be opened now. */
  canRequest: boolean;
  /** Why not (a code the page words), when the shop offers requests but this order cannot. */
  closedReason: 'returns_unavailable' | 'return_window_closed' | null;
  windowDays: number;
  lines: StorefrontReturnLine[];
  requests: StorefrontReturnRequest[];
}

export interface ReturnableItem { id: string; name: string; quantity: number }

/** The order's lines a buyer may return: not a free gift, not a download. */
export async function loadReturnableItemsTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<ReturnableItem[]> {
  const rows = await tx.$queryRaw<{ id: string; name: string | null; quantity: number }[]>`
    SELECT i.id::text AS id, i.name, i.quantity FROM order_items i
    LEFT JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    LEFT JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid AND NOT i.is_gift AND NOT COALESCE(p.is_digital, false)
    ORDER BY i.id LIMIT 100`;
  return rows.map((r) => ({ id: r.id, name: r.name ?? '-', quantity: r.quantity }));
}

interface ReturnRow { id: string; status: StorefrontReturnRequest['status']; items: unknown; reason: string | null; exchange: unknown; source: string;
  approved_at: Date | null; created_at: Date }

const asItems = (value: unknown): Array<{ order_item_id: string; qty: number }> =>
  Array.isArray(value) ? value.filter((l): l is { order_item_id: string; qty: number } =>
    !!l && typeof (l as { order_item_id?: unknown }).order_item_id === 'string' && Number.isInteger((l as { qty?: unknown }).qty)) : [];

/** The returns block of the buyer's order view; null when the shop offers none and the order has no request. */
export async function loadReturnsViewTx(tx: TenantTransaction, accountId: string, orderId: string, now = new Date()): Promise<StorefrontReturns | null> {
  const settings = await loadBuyerSettingsTx(tx, accountId);
  const returns = await tx.$queryRaw<ReturnRow[]>`SELECT id::text AS id, status, items, reason, exchange, source, approved_at, created_at
    FROM order_returns WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid ORDER BY created_at LIMIT 50`;
  if (!settings.buyer_returns_enabled && returns.length === 0) return null;
  const items = await loadReturnableItemsTx(tx, accountId, orderId);
  const nameOf = new Map(items.map((i) => [i.id, i.name]));
  const [facts] = await tx.$queryRaw<{ status: string; unpaid_cod: boolean; delivered_at: Date | null; days: number | null }[]>`
    SELECT o.status, (o.payment_method='cod' AND o.paid_at IS NULL AND o.priced_at IS NOT NULL) AS unpaid_cod,
      CASE WHEN o.status='fulfilled' THEN COALESCE(o.delivered_at, o.dispatched_at) END AS delivered_at, s.return_window_days AS days
    FROM orders o LEFT JOIN commerce_settings s ON s.account_id=o.account_id
    WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
  if (!facts) return null;
  const windowDays = facts.days ?? DEFAULT_RETURN_WINDOW_DAYS;
  const refusal = buyerReturnEligibility({
    enabled: settings.buyer_returns_enabled, status: facts.status, unpaidCod: facts.unpaid_cod, deliveredAt: facts.delivered_at, windowDays, now,
  });
  const standings = lineStandings(items.map((i) => ({ id: i.id, quantity: i.quantity })),
    returns.map((r) => ({ status: r.status, items: asItems(r.items) })));
  const options = refusal === null && items.length ? await tx.$queryRaw<{ item_id: string; variant_id: string; option_values: Record<string, string> | null; name: string }[]>`
    SELECT i.id::text AS item_id, v2.id::text AS variant_id, v2.option_values, p.name FROM order_items i
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_variants v2 ON v2.account_id=v.account_id AND v2.product_id=v.product_id AND v2.id<>v.id
    JOIN shop_products p ON p.account_id=v2.account_id AND p.id=v2.product_id
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
      AND v2.archived_at IS NULL AND v2.price_minor IS NOT NULL AND NOT p.is_bundle AND NOT p.is_digital
      AND COALESCE(shop_variant_availability(v2.account_id, v2.id), 1) > 0
    ORDER BY i.id, v2.position, v2.id LIMIT 600` : [];
  const optionsOf = new Map<string, Array<{ variantId: string; label: string }>>();
  for (const o of options) {
    const list = optionsOf.get(o.item_id) ?? [];
    if (list.length < EXCHANGE_OPTIONS_PER_LINE) {
      const text = Object.values(o.option_values ?? {}).filter(Boolean).join(', ');
      list.push({ variantId: o.variant_id, label: text || o.name });
    }
    optionsOf.set(o.item_id, list);
  }
  return {
    canRequest: refusal === null && items.some((i) => { const s = standings.get(i.id)!; return s.remaining > 0 && !s.open; }),
    closedReason: settings.buyer_returns_enabled ? refusal : null,
    windowDays,
    lines: items.map((i) => {
      const s = standings.get(i.id)!;
      return { id: i.id, name: i.name, remaining: s.remaining, open: s.open, exchangeOptions: optionsOf.get(i.id) ?? [] };
    }),
    requests: returns.map((r) => ({
      id: r.id, status: r.status, pendingApproval: r.source === 'buyer' && !r.approved_at && r.status === 'requested',
      reason: (r.reason as ReturnReason | null) ?? null, exchange: r.exchange !== null && typeof r.exchange === 'object',
      lines: asItems(r.items).map((l) => ({ name: nameOf.get(l.order_item_id) ?? '-', qty: l.qty })), createdAt: r.created_at.toISOString(),
    })),
  };
}
