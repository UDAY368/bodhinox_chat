/**
 * The public shop's data cache (store Batch 6, speed).
 *
 * What a visitor reads on the home, category, collection, all-products, product, search and store pages, the sitemap and the shop
 * row itself is kept for SHOP_CACHE_SECONDS in Next's data cache (unstable_cache: works with this app's config, no cacheComponents).
 * Every entry's key holds the account id, the handle and every argument, so two shops never share one, and every entry carries the
 * tag `shop:<accountId>`.
 *
 * Only the data is cached, never the gate: resolve_public_shop, the plan feature, the suspension check and the access mode (password
 * cookie, coming soon) run on every request before a cached loader is asked (withPublicShopData in public-shop.ts). Nothing about a
 * signed-in buyer (account, wishlist, cart, checkout, tracking) goes through here.
 *
 * revalidateShop(accountId) is called after every committed write a visitor would see (products, prices, stock, categories,
 * collections, theme, settings, access mode, reviews, imports). Outside a Next request (the worker, a script) revalidateTag is not
 * available; the call is then a no-op and the short TTL bounds how stale a page can be. Stock on a cached page can be up to
 * SHOP_CACHE_SECONDS old: checkout always checks stock again on the server (stock holds), so nothing is oversold.
 */
import { revalidateTag, unstable_cache } from 'next/cache';

/** How long a cached shop page's data lives at most (seconds). */
export const SHOP_CACHE_SECONDS = 90;

export const shopTag = (accountId: string): string => `shop:${accountId}`;

/** Outside a Next server (tests, the worker, scripts) there is no data cache: the loader just runs. */
function noCacheHere(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Invariant: incrementalCache missing');
}

/**
 * `load(...args)` through the data cache. `name` names the loader; the key is [name, accountId, handle] plus the JSON of `args`
 * (each loader passes every value it reads as an argument). The result must be plain JSON (no Date, no bigint).
 */
export async function shopCached<A extends unknown[], R>(name: string, accountId: string, handle: string,
  load: (...args: A) => Promise<R>, ...args: A): Promise<R> {
  const cached = unstable_cache(load, ['shop-data-v1', name, accountId, handle], { tags: [shopTag(accountId)], revalidate: SHOP_CACHE_SECONDS });
  try {
    return await cached(...args);
  } catch (error) {
    if (noCacheHere(error)) return load(...args);
    throw error;
  }
}

/**
 * Drop a shop's cached pages after a committed write. Call it after the transaction, never inside one that may still roll back.
 * Never throws: outside a Next request (worker, script) it does nothing and the TTL bounds staleness.
 */
export function revalidateShop(accountId: string | null | undefined): void {
  if (!accountId) return;
  try {
    // expire 0: the next visitor gets fresh data, not the stale copy.
    revalidateTag(shopTag(accountId), { expire: 0 });
  } catch {
    // No Next request here (the worker, a script, a test).
  }
}
