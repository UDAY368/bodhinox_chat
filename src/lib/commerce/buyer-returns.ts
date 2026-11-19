/**
 * A buyer's return or exchange request from the order page (store plan Phase 8, batch 5).
 *
 * The buyer is the contact the order page's token belongs to, and the order must be that session's own order (an order of
 * another contact, or of another workspace, is never reachable: the session row decides, never an id from the page). The
 * request is a row of order_returns with source 'buyer', reason, and for an exchange the replacement variant per line. It
 * does not refund, restock or move any money: staff approve or reject it in the returns flow (returns.ts), and an approved
 * exchange makes its replacement order there.
 *
 * Checked under the order lock, so two requests at once cannot both take a line: the shop offers requests (admin setting),
 * the order has left the store and is not an unpaid cash-on-delivery order, the store's return window (counted from
 * delivery, as for staff) is open, each line belongs to the order, is not a gift or a download, has units left (ordered minus
 * every non-rejected return) and has no open request, and an exchange names another live, priced, in-stock variant of the same
 * product. A replay of the same clientRequestId answers the request it already made, even after the window has closed.
 * Nothing about the request is logged but ids.
 */
import { loadBuyerSettingsTx } from './buyer-settings';
import { loadReturnableItemsTx } from './buyer-returns-view';
import { lockOrder } from './order-lifecycle';
import { buyerReturnEligibility, exchangeMap, lineStandings, parseBuyerReturn } from './return-rules';
import { loadSession, loadVariants } from './storefront';
import { StoreError } from './store-settings';
import type { TenantTransaction } from '@/lib/db/tenant';

export interface BuyerReturnResult { returnId: string; created: boolean }

const DEFAULT_RETURN_WINDOW_DAYS = 7;

export async function requestBuyerReturnTx(
  tx: TenantTransaction, accountId: string, sessionId: string, body: Record<string, unknown>, now = new Date(),
): Promise<BuyerReturnResult> {
  const input = parseBuyerReturn(body);
  const session = await loadSession(tx, accountId, sessionId);
  if (!session || session.revoked_at || !session.order_id) throw new StoreError('returns_unavailable');
  const orderId = session.order_id;

  const replay = async (): Promise<BuyerReturnResult | null> => {
    const [hit] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_returns
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND client_request_id=${input.clientRequestId}::uuid`;
    return hit ? { returnId: hit.id, created: false } : null;
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const order = await lockOrder(tx, accountId, orderId);
  // A request that raced this one and committed first.
  const raced = await replay();
  if (raced) return raced;

  const [facts] = await tx.$queryRaw<{ contact_id: string | null; delivered_at: Date | null; days: number | null }[]>`
    SELECT o.contact_id::text AS contact_id, CASE WHEN o.status='fulfilled' THEN COALESCE(o.delivered_at, o.dispatched_at) END AS delivered_at,
      s.return_window_days AS days
    FROM orders o LEFT JOIN commerce_settings s ON s.account_id=o.account_id
    WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
  // The order must be the session contact's own (a staff-linked status page of a contact never reaches another contact's order).
  if (!facts || facts.contact_id !== session.contact_id) throw new StoreError('returns_unavailable');
  const settings = await loadBuyerSettingsTx(tx, accountId);
  const refusal = buyerReturnEligibility({
    enabled: settings.buyer_returns_enabled, status: order.status, unpaidCod: order.unpaidCod, deliveredAt: facts.delivered_at,
    windowDays: facts.days ?? DEFAULT_RETURN_WINDOW_DAYS, now,
  });
  if (refusal) throw new StoreError(refusal);

  const items = await loadReturnableItemsTx(tx, accountId, orderId);
  const returns = await tx.$queryRaw<{ status: string; items: unknown }[]>`SELECT status, items FROM order_returns
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid`;
  const standings = lineStandings(items.map((i) => ({ id: i.id, quantity: i.quantity })), returns.map((r) => ({
    status: r.status, items: Array.isArray(r.items) ? r.items as Array<{ order_item_id: string; qty: number }> : [],
  })));
  for (const line of input.lines) {
    const standing = standings.get(line.order_item_id);
    if (!standing) throw new StoreError('invalid', { field: 'lines' });
    if (standing.open) throw new StoreError('return_line_open');
    if (line.qty > standing.remaining) throw new StoreError('return_quantity');
  }

  // An exchange names another variant of the same product that can be bought now.
  const wanted = input.lines.filter((l) => l.exchange_variant_id);
  if (wanted.length) {
    const ids = wanted.map((l) => l.exchange_variant_id!);
    const variants = await loadVariants(tx, accountId, ids);
    const same = await tx.$queryRaw<{ item_id: string }[]>`
      SELECT i.id::text AS item_id FROM order_items i
      JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
      JOIN shop_variants v2 ON v2.account_id=v.account_id AND v2.product_id=v.product_id AND v2.id<>v.id
      WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid
        AND (i.id, v2.id) IN (SELECT (x->>'i')::uuid, (x->>'v')::uuid FROM jsonb_array_elements(${JSON.stringify(wanted.map((l) => ({ i: l.order_item_id, v: l.exchange_variant_id })))}::jsonb) x)`;
    const ok = new Set(same.map((r) => r.item_id));
    for (const l of wanted) {
      const v = variants.get(l.exchange_variant_id!);
      if (!ok.has(l.order_item_id) || !v || !v.sellable || v.priceMinor === null || (v.available !== null && v.available < l.qty))
        throw new StoreError('exchange_unavailable', { variantId: l.exchange_variant_id! });
    }
  }

  const lines = input.lines.map((l) => ({ order_item_id: l.order_item_id, qty: l.qty }));
  const exchange = exchangeMap(input.lines);
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO order_returns(account_id, order_id, items, note, source, reason, contact_id, client_request_id, exchange)
    VALUES(${accountId}::uuid, ${orderId}::uuid, ${JSON.stringify(lines)}::jsonb, ${input.note}, 'buyer', ${input.reason}, ${session.contact_id}::uuid,
      ${input.clientRequestId}::uuid, ${exchange ? JSON.stringify(exchange) : null}::jsonb)
    ON CONFLICT (account_id, order_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
    RETURNING id::text AS id`;
  if (!inserted[0]) return (await replay()) ?? Promise.reject(new StoreError('conflict'));
  await tx.$executeRaw`INSERT INTO order_events(account_id, order_id, kind, actor) VALUES(${accountId}::uuid, ${orderId}::uuid, 'return_requested', 'customer')`;
  return { returnId: inserted[0].id, created: true };
}
