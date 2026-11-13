// POST /api/commerce/shop/products/[id]/duplicate { name? } — copy a product as a new draft (admins): same content,
//   category, images and variants (SKUs suffixed -copy, -copy2...), no stock. 201 { product }. 404 not_found.
export const runtime = 'nodejs';

import { duplicateProduct } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = (await readJson(request)) ?? {};
    return json({ product: await inTenant(caller, (tx) => duplicateProduct(tx, caller.accountId, caller.userId, id, body)) }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
