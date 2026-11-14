// POST /api/public/store/<handle>/cart  { lines: [{ variantId, qty }] }
// Current names, prices and stock for the visitor's browser cart. Read-only:
// nothing is stored. Lines no longer on sale come back in `removed`.

import { inShopTenant, parseCartLines, previewCartTx, resolvePublicShop } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'cart', async (handle, body) => {
    const lines = parseCartLines(body.lines);
    const accountId = await resolvePublicShop(handle);
    if (!accountId) return null;
    return inShopTenant(accountId, (tx) => previewCartTx(tx, accountId, lines));
  });
}
