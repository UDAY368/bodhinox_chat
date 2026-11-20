/**
 * The link-in-bio page of the public shop (store plan Phase 8, batch 6): /s/<handle>/links. The shop's logo and name, a short bio,
 * the admin's links in their order (plain http(s) URLs, at most 12) and up to six featured products, in the shop's theme. Admins
 * edit it (RLS and the route both check); agents read. It lives inside the shop layout, so a password or "coming soon" shop shows
 * its lock screen here too, and a page that is switched off is the plain 404.
 */
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { appOrigin } from '@/lib/auth/csrf';
import { LINK_PAGE_LIMITS, readStoredLinks, type LinkPageInput, type PageLink } from './link-page-rules';
import { loadPublicShopTx, withPublicShop, type PublicProduct, type PublicShop } from './public-shop';
import { shopImageUrl } from './shop-images';
import { loadProductsWith } from './shop-products';
import { auditStoreChange, StoreError } from './store-settings';

export interface LinkPageView {
  enabled: boolean;
  bio: string | null;
  links: PageLink[];
  featured_product_ids: string[];
  /** The public address, once the shop is published. */
  url: string | null;
}

interface Row { enabled: boolean; bio: string | null; links: unknown; featured_product_ids: unknown }

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, LINK_PAGE_LIMITS.featured) : []);

export function getLinkPage(ctx: TenantContext): Promise<LinkPageView> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<Row[]>`SELECT enabled, bio, links, featured_product_ids FROM shop_link_page WHERE account_id=${ctx.accountId}::uuid`;
    const [shop] = await tx.$queryRaw<{ handle: string; published: boolean }[]>`SELECT handle, published FROM shop_storefronts WHERE account_id=${ctx.accountId}::uuid`;
    return {
      enabled: row?.enabled ?? false, bio: row?.bio ?? null, links: readStoredLinks(row?.links), featured_product_ids: ids(row?.featured_product_ids),
      url: shop?.published ? `${appOrigin()}/s/${shop.handle}/links` : null,
    };
  });
}

export async function saveLinkPage(ctx: TenantContext & { userId: string }, input: LinkPageInput): Promise<LinkPageView> {
  await withTenant(ctx, async (tx) => {
    if (input.featuredProductIds.length) {
      const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_products
        WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${input.featuredProductIds}::uuid[])`;
      if (found.length !== input.featuredProductIds.length) throw new StoreError('invalid', { field: 'featured_product_ids' });
    }
    await tx.$executeRaw`INSERT INTO shop_link_page(account_id,enabled,bio,links,featured_product_ids)
      VALUES(${ctx.accountId}::uuid,${input.enabled},${input.bio},${JSON.stringify(input.links)}::jsonb,${JSON.stringify(input.featuredProductIds)}::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET enabled=EXCLUDED.enabled, bio=EXCLUDED.bio, links=EXCLUDED.links, featured_product_ids=EXCLUDED.featured_product_ids`;
    // Counts only: the labels and addresses are the seller's own words and stay out of the audit trail.
    await auditStoreChange(tx, ctx, 'commerce.link_page_saved', ctx.accountId, { enabled: input.enabled, links: input.links.length, featured: input.featuredProductIds.length });
  });
  return getLinkPage(ctx);
}

export interface PublicLinkPage { shop: PublicShop; bio: string | null; links: PageLink[]; products: PublicProduct[] }

/** What a visitor sees; null when the shop is not open to them or the page is off. */
export function loadPublicLinkPage(handle: string): Promise<PublicLinkPage | null> {
  return withPublicShop(handle, async (tx, accountId) => {
    const [row] = await tx.$queryRaw<Row[]>`SELECT enabled, bio, links, featured_product_ids FROM shop_link_page WHERE account_id=${accountId}::uuid`;
    if (!row?.enabled) return null;
    const shop = await loadPublicShopTx(tx, accountId);
    if (!shop) return null;
    const wanted = ids(row.featured_product_ids);
    const found = wanted.length ? await loadProductsWith(tx, accountId, { productIds: wanted, limit: LINK_PAGE_LIMITS.featured }, (image) => shopImageUrl(handle, image.id)) : [];
    // The admin's order; a product that is no longer on sale is left out.
    const products = wanted.flatMap((id) => found.filter((p) => p.id === id));
    return { shop, bio: row.bio, links: readStoredLinks(row.links), products };
  }).then((page) => page ?? null);
}
