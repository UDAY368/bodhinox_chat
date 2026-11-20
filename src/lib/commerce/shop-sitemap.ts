/**
 * One shop's sitemap (store Batch 6): /s/<handle>/sitemap.xml. Runs as a visitor through withPublicShop, so a shop that is
 * unpublished, suspended, locked by a password or "coming soon" has none (the route answers 404), and every query is the handle's own
 * account. Lists the home and all-products pages, the store pages that exist, active categories with a live product, published
 * collections, and live products (published, inside their publish/hide window, with a priced variant) by slug, newest change first.
 *
 * Caps (a sitemap file allows 50,000 addresses): SITEMAP_PRODUCT_LIMIT products and SITEMAP_GROUP_LIMIT each of categories and
 * collections, each a LIMIT in SQL. A larger catalogue still lists its most recently changed products; the rest stay reachable
 * through the category and all-products pages.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { loadPublicShopWithContent, withPublicShop } from './public-shop';
import { categoryPath, productPath } from './shop-paths';
import { POLICY_SLUGS } from './shop-sections';

export const SITEMAP_PRODUCT_LIMIT = 10_000;
export const SITEMAP_GROUP_LIMIT = 500;

export interface SitemapEntry { path: string; lastModified?: string }

async function entriesTx(tx: TenantTransaction, accountId: string, handle: string): Promise<SitemapEntry[] | null> {
  const loaded = await loadPublicShopWithContent(tx, accountId);
  if (!loaded) return null;
  const base = `/s/${handle}`;
  const pages = loaded.shop.pages;
  const entries: SitemapEntry[] = [{ path: base }, { path: `${base}/all` }];
  for (const slug of ['about', 'contact', 'faq'] as const) if (pages[slug]) entries.push({ path: `${base}/pages/${slug}` });
  for (const slug of POLICY_SLUGS) entries.push({ path: `${base}/pages/${slug}` });

  const categories = await tx.$queryRaw<{ id: string; slug: string | null; updated_at: Date }[]>`
    SELECT c.id::text AS id, c.slug, c.updated_at FROM shop_categories c
    WHERE c.account_id=${accountId}::uuid AND c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM shop_products p WHERE p.account_id=c.account_id AND p.category_id=c.id
        AND shop_product_live(p.status, p.publish_at, p.hide_at)
        AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL))
    ORDER BY c.position, c.name, c.id LIMIT ${SITEMAP_GROUP_LIMIT}`;
  for (const c of categories) entries.push({ path: categoryPath(handle, c), lastModified: c.updated_at.toISOString() });

  const collections = await tx.$queryRaw<{ slug: string; updated_at: Date }[]>`
    SELECT slug, updated_at FROM shop_collections WHERE account_id=${accountId}::uuid AND published
    ORDER BY title, id LIMIT ${SITEMAP_GROUP_LIMIT}`;
  for (const c of collections) entries.push({ path: `${base}/collections/${c.slug}`, lastModified: c.updated_at.toISOString() });

  const products = await tx.$queryRaw<{ id: string; slug: string | null; updated_at: Date }[]>`
    SELECT p.id::text AS id, p.slug, p.updated_at FROM shop_products p
    WHERE p.account_id=${accountId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
    ORDER BY p.updated_at DESC, p.id LIMIT ${SITEMAP_PRODUCT_LIMIT}`;
  for (const p of products) entries.push({ path: productPath(handle, p), lastModified: p.updated_at.toISOString() });
  return entries;
}

/** The shop's sitemap entries (paths), or null when the shop is not open to visitors. */
export async function loadShopSitemap(handle: string): Promise<SitemapEntry[] | null> {
  return (await withPublicShop(handle, (tx, accountId) => entriesTx(tx, accountId, handle))) ?? null;
}

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** A urlset document; `origin` makes every path absolute (sitemaps need full addresses). */
export function sitemapXml(entries: readonly SitemapEntry[], origin: string): string {
  const urls = entries.map((e) => `<url><loc>${xmlEscape(`${origin}${e.path}`)}</loc>${e.lastModified ? `<lastmod>${xmlEscape(e.lastModified)}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
