// GET /s/<handle>/sitemap.xml  one shop's sitemap (store Batch 6; see src/lib/commerce/shop-sitemap.ts for what it lists and the caps).
// Only a published shop that is open to visitors has one; anything else is the plain 404, as for its pages.

import { isShopHandleFormat } from '@/lib/commerce/public-shop';
import { loadShopSitemap, sitemapXml } from '@/lib/commerce/shop-sitemap';
import { shopOrigin } from '@/lib/commerce/shop-seo';
import { burstAllowed, notFound, publicError, tooMany } from '@/app/api/public/shop/_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ handle: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { handle } = await params;
    const origin = shopOrigin();
    if (!isShopHandleFormat(handle) || !origin) return notFound();
    const entries = await loadShopSitemap(handle);
    if (!entries) return notFound();
    // Not cached: a shop that is locked or unpublished must stop listing at once.
    return new Response(sitemapXml(entries, origin), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (error) {
    return publicError(error, 'store:sitemap');
  }
}
