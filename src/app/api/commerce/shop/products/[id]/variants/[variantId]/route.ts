// PATCH /api/commerce/shop/products/[id]/variants/[variantId] — any variant field, or { archived: boolean } (admins).
//   200 { product }. A published product must keep one priced, active variant (409 needs_priced_variant).
//   Stock changes only through /api/commerce/inventory/[variantId]/adjust.
export const runtime = 'nodejs';

import { upsertVariant } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../../../../_lib/http';

type Context = { params: Promise<{ id: string; variantId: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const { id, variantId } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    const product = await inTenant(caller, (tx) => upsertVariant(tx, caller.accountId, caller.userId, id, variantId, body));
    return json({ product });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
