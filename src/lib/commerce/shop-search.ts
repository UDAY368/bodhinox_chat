/**
 * Shop search (store plan Phase 8, batch 7): the box in the shop header, its suggestions and the results page. Matches the product name,
 * a variant SKU or the category name (every typed word must match one of them), only among products a visitor can see: live by the
 * publish and hide dates (shop_product_live), with a priced variant, in a shop that is open to the visitor (a password or coming-soon
 * shop answers nothing). ILIKE with escaped wildcards and a small limit; no extra index (the catalogue of one shop is small and the
 * scan is by account_id). The typed text is never logged.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { likeContains, likePrefix, searchTerms, SEARCH_RESULTS, SEARCH_SUGGESTIONS } from './shop-insights-rules';
import { loadProductsWith, shopImageUrl, withPublicShop, type PublicProduct } from './public-shop';

/** `slug` (store Batch 6) builds the link with productPath(). */
export interface Suggestion { id: string; slug: string | null; name: string; category: string | null }

async function matchProducts(tx: TenantTransaction, accountId: string, terms: string[], limit: number): Promise<Suggestion[]> {
  const contains = terms.map(likeContains);
  const first = likePrefix(terms[0]);
  return tx.$queryRaw<Suggestion[]>`
    SELECT p.id::text AS id, p.slug, p.name, c.name AS category
    FROM shop_products p
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    WHERE p.account_id=${accountId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(${contains}::text[]) AS w(pattern)
        WHERE NOT (p.name ILIKE w.pattern ESCAPE '\\' OR COALESCE(c.name, '') ILIKE w.pattern ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.sku ILIKE w.pattern ESCAPE '\\')))
    ORDER BY (p.name ILIKE ${first} ESCAPE '\\') DESC, p.name, p.id
    LIMIT ${limit}`;
}

/** Up to 8 products for the suggestion list; [] for a too-short query; null when there is no open shop. */
export function searchSuggestions(handle: string, query: unknown): Promise<Suggestion[] | null> {
  const terms = searchTerms(query);
  return withPublicShop(handle, async (tx, accountId) => (terms.length ? matchProducts(tx, accountId, terms, SEARCH_SUGGESTIONS) : []));
}

export interface SearchPage { query: string; products: PublicProduct[] }

/** The results page: up to 24 full product cards in match order; null when there is no open shop. */
export function searchShop(handle: string, query: unknown): Promise<SearchPage | null> {
  const terms = searchTerms(query);
  return withPublicShop(handle, async (tx, accountId): Promise<SearchPage> => {
    if (!terms.length) return { query: '', products: [] };
    const ids = (await matchProducts(tx, accountId, terms, SEARCH_RESULTS)).map((s) => s.id);
    if (!ids.length) return { query: terms.join(' '), products: [] };
    const found = await loadProductsWith(tx, accountId, { productIds: ids, limit: SEARCH_RESULTS }, (image) => shopImageUrl(handle, image.id));
    // loadProductsWith returns catalogue order; the results keep the match order.
    return { query: terms.join(' '), products: ids.flatMap((id) => found.filter((p) => p.id === id)) };
  });
}
