// POST /api/public/store/<handle>/cart  { lines: [{ variantId, qty }], pincode?, coupon? }
// Current names, prices and stock for the visitor's browser cart. Read-only:
// nothing is stored. Lines no longer on sale come back in `removed`; `suggestions`
// are up to four public products often bought with the cart's products.
// `estimate` prices the sellable lines with the optional pincode and coupon
// (cart-estimate.ts): no contact, no session, nothing reserved, the coupon is
// checked but never redeemed. The pincode and code are not stored or logged.

import { estimateCartTx, parseEstimateInput } from '@/lib/commerce/cart-estimate';
import { inShopTenant, loadBoughtTogether, parseCartLines, previewCartTx, resolvePublicShop } from '@/lib/commerce/public-shop';
import { shopPost, type HandleParams } from '../../_lib/shop';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request, context: HandleParams) {
  return shopPost(request, context, 'cart', async (handle, body) => {
    const lines = parseCartLines(body.lines);
    const estimateInput = parseEstimateInput(body);
    const accountId = await resolvePublicShop(handle);
    if (!accountId) return null;
    return inShopTenant(accountId, async (tx) => {
      const preview = await previewCartTx(tx, accountId, lines);
      const seeds = [...new Set(preview.lines.map((l) => l.productId))];
      const sellable = preview.lines.map((l) => ({ variantId: l.variantId, qty: l.qty }));
      return {
        ...preview,
        suggestions: await loadBoughtTogether(tx, accountId, handle, seeds),
        estimate: await estimateCartTx(tx, accountId, sellable, estimateInput),
      };
    });
  });
}
