// POST /api/commerce/shop/import { meta_product_ids: uuid[] (1-100) } — create draft products from mirrored Meta
//   products (admins). Never overwrites: an existing SKU is skipped. 200 { created, skipped }.
export const runtime = 'nodejs';

import { importFromMeta } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json(await inTenant(caller, (tx) => importFromMeta(tx, caller.accountId, caller.userId, body)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
