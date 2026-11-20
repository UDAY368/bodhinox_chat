// GET /api/public/store/<handle>/products?ids=<uuid>,<uuid>…  -> { products: PublicProduct[] } (card data, at most 12, in the order asked)
// The home page's "Recently viewed" section: the visitor's browser sends the product ids it opened on this shop. Only this shop's
// published, sellable products come back (withPublicShop: the handle's own workspace, inside its tenant transaction); ids of another
// shop, hidden or unknown products are left out. A shop not open to the visitor, a bad handle or a bad list is the plain 404 / 400.

import { burstAllowed, json, notFound, publicError, tooMany } from '../../../shop/_lib/public';
import { isShopHandleFormat } from '@/lib/commerce/public-shop';
import { loadShopProductCards, parseProductIds } from '@/lib/commerce/shop-recently-viewed';
import type { HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: HandleParams) {
  try {
    if (!(await burstAllowed('read', request))) return tooMany();
    const { handle } = await params;
    if (!isShopHandleFormat(handle)) return notFound();
    const ids = parseProductIds(new URL(request.url).searchParams.get('ids'));
    if (!ids) return json({ code: 'invalid' }, 400);
    const products = await loadShopProductCards(handle, ids);
    return products === null ? notFound() : json({ products });
  } catch (error) {
    return publicError(error, 'store:products');
  }
}
