/**
 * "Recently viewed" (batch 6): the visitor's browser keeps the ids of the
 * products it opened (localStorage, per shop); the home page section asks
 * GET /api/public/store/<handle>/products?ids=… for their cards. Only that
 * shop's published, sellable products come back (the ordinary public product
 * load inside the shop's tenant transaction), in the order asked, as card
 * data (no description or detail rows). Unknown, foreign or hidden ids are
 * simply missing from the answer.
 */
import { loadProductsWith, shopImageUrl, withPublicShop, type PublicProduct } from './public-shop';

export const RECENT_IDS_MAX = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Up to 12 distinct product ids from "a,b,c"; anything malformed is dropped. Null when the list is missing or too long. */
export function parseProductIds(value: string | null): string[] | null {
  if (value === null || value.length > RECENT_IDS_MAX * 40) return null;
  const ids = [...new Set(value.split(',').map((id) => id.trim().toLowerCase()).filter((id) => UUID.test(id)))];
  return ids.length > RECENT_IDS_MAX ? null : ids;
}

/** Card data for `ids` on the shop at `handle`, in the order given; null when the shop is not open. */
export function loadShopProductCards(handle: string, ids: string[]): Promise<PublicProduct[] | null> {
  return withPublicShop(handle, async (tx, accountId) => {
    if (!ids.length) return [];
    const products = await loadProductsWith(tx, accountId, { productIds: ids, limit: ids.length }, (image) => shopImageUrl(handle, image.id));
    const byId = new Map(products.map((p) => [p.id, { ...p, description: null, disclosure: null, details: [] }]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  });
}
