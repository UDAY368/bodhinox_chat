// POST   /api/commerce/shop/products/[id]/publish { version? } — publish (admins). Needs one priced, active variant
//   (409 needs_priced_variant); records the publishing admin as content reviewer. 200 { product }.
// DELETE /api/commerce/shop/products/[id]/publish — back to draft, off the storefront (admins). 200 { product }.
export const runtime = 'nodejs';

import { publishProduct, unpublishProduct } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = (await readJson(request)) ?? {};
    return json({ product: await inTenant(caller, (tx) => publishProduct(tx, caller.accountId, caller.userId, id, body)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    return json({ product: await inTenant(caller, (tx) => unpublishProduct(tx, caller.accountId, caller.userId, id)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
