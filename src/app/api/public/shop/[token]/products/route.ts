// GET /api/public/shop/<token>/products?q=&category=&cursor=  one page of the storefront catalogue
// (shop links only, while the session is open): published, priced products, optionally searched by name or
// description and narrowed to one category. 200 { products, nextCursor }. Only sha256(token) reaches the
// database; the search term is never logged. Read-only.

import { isStorefrontTokenFormat } from '@/lib/commerce/storefront-token';
import { loadCatalogue, loadSession } from '@/lib/commerce/storefront';
import { burstAllowed, inPublicTenant, json, notFound, publicError, resolveToken, tooMany, type TokenParams } from '../../_lib/public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: TokenParams) {
  if (!burstAllowed('read', request)) return tooMany();
  try {
    const { token } = await params;
    if (!isStorefrontTokenFormat(token)) return notFound();
    const ref = await resolveToken(token, request);
    if (!ref) return notFound();
    const search = new URL(request.url).searchParams;
    const page = await inPublicTenant(ref.accountId, async (tx) => {
      const session = await loadSession(tx, ref.accountId, ref.sessionId);
      // As the view: only an open shop link that has not placed its order lists products.
      if (!session || session.revoked_at || session.purpose !== 'shop' || session.order_id || session.expires_at.getTime() <= Date.now()) return null;
      return loadCatalogue(tx, ref.accountId, { query: search.get('q'), categoryId: search.get('category'), cursor: search.get('cursor') });
    });
    return page ? json(page) : notFound();
  } catch (error) {
    return publicError(error, 'products');
  }
}
