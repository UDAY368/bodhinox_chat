// POST /api/commerce/shop/products/[id]/variants { sku, option_values?, price_minor?, compare_at_minor?, tax_rate_bps?,
//   hsn_code?, track_inventory?, weight_grams?, position?, archived? } (admins). 201 { product }.
//   409 sku_taken; 409 store_not_configured when a price is set before the store currency exists.
export const runtime = 'nodejs';

import { upsertVariant } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    const product = await inTenant(caller, (tx) => upsertVariant(tx, caller.accountId, caller.userId, id, null, body));
    return json({ product }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
