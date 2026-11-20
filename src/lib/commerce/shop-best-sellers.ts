/**
 * The home page's "Best sellers" section (batch 6): the shop's published,
 * sellable products ranked by real sales. A sale counts when the order was
 * paid (or later: partly shipped, dispatched, fulfilled) or is a confirmed
 * cash-on-delivery order, the same rule as "often bought together". One
 * grouped SQL query with a LIMIT inside the shop's tenant transaction; only
 * product ids leave it, and the public product load draws the cards, so no
 * counts, order ids or buyer data reach the page.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import type { PublicProduct } from './public-shop';
import type { ShopSection } from './shop-sections';

/** The most products one best sellers section shows. */
export const BEST_SELLERS_MAX = 12;
export const BEST_SELLERS_DEFAULT_DAYS = 30;

/** Product ids ranked by distinct counted orders in the last `days` days (ties by name), at most `limit`. */
export async function loadBestSellerIds(tx: TenantTransaction, accountId: string, limit: number, days = BEST_SELLERS_DEFAULT_DAYS): Promise<string[]> {
  const take = Math.max(1, Math.min(BEST_SELLERS_MAX, Math.trunc(limit)));
  const window = Math.max(1, Math.min(365, Math.trunc(days)));
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id::text AS id
    FROM orders o
    JOIN order_items i ON i.account_id=o.account_id AND i.order_id=o.id
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id AND shop_product_live(p.status, p.publish_at, p.hide_at)
    WHERE o.account_id=${accountId}::uuid AND o.created_at > now() - make_interval(days => ${window}::int)
      AND (o.status IN ('paid','partially_shipped','dispatched','fulfilled') OR (o.status='confirmed' AND o.payment_method='cod'))
    GROUP BY p.id, p.name
    ORDER BY count(DISTINCT o.id) DESC, p.name, p.id
    LIMIT ${take}`;
  return rows.map((r) => r.id);
}

/**
 * The best sellers for the home page, in rank order: nothing unless a visible
 * best sellers section asks (its days; the most any such section shows).
 * `load` is the public product load for those ids (published with a priced variant).
 */
export async function loadHomeBestSellers(tx: TenantTransaction, accountId: string, sections: ShopSection[],
  load: (ids: string[]) => Promise<PublicProduct[]>): Promise<PublicProduct[]> {
  const wanted = sections.filter((s) => !s.hidden && s.type === 'best_sellers');
  if (!wanted.length) return [];
  const days = typeof wanted[0].settings.days === 'number' ? wanted[0].settings.days : BEST_SELLERS_DEFAULT_DAYS;
  const ids = await loadBestSellerIds(tx, accountId, BEST_SELLERS_MAX, days);
  if (!ids.length) return [];
  const byId = new Map((await load(ids)).map((p) => [p.id, p]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}
