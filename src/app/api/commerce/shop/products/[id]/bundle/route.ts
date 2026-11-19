// PUT /api/commerce/shop/products/[id]/bundle { parts: [{ variant_id, quantity }] } — replace the parts of a
//   bundle product (admins). At most 20 distinct active variants of other physical products, quantity 1 to 99.
//   200 { product }; 400 { code: 'invalid', field: 'parts' | 'is_bundle' }. The bundle itself is sold at its own
//   variants' prices; the parts only decide stock.
export const runtime = 'nodejs';

import { setBundleParts } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../_lib/http';

export async function PUT(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ product: await inTenant(caller, (tx) => setBundleParts(tx, caller.accountId, caller.userId, id, body)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
