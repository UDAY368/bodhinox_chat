// GET   /api/commerce/shop/products/[id] — the product with variants (stock included) and images (agents and above).
//   200 { product }. Another account's id is a 404.
// PATCH /api/commerce/shop/products/[id] { version?, name?, description?, disclosure?, category_id?, follow_up_*?, images? }
//   (admins). 200 { product }; 409 { code: 'conflict' } when `version` is stale. Editing the content of a published
//   product records the editor as its reviewer. With `variants` (the options matrix) and `parts` it is the product form's one Save:
//   everything in one transaction, then the typed stock counts (200 { product, stock_error? }).
export const runtime = 'nodejs';

import { getShopProduct } from '@/lib/commerce/catalogue/products';
import { saveProduct } from '../../_lib/product-save';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../_lib/http';

export async function GET(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ product: await inTenant(caller, (tx) => getShopProduct(tx, caller.accountId, id)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    // The save 404s an invalid or foreign id before writing.
    return json(await saveProduct(caller, id, body));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
