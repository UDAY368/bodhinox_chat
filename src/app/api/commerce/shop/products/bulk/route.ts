// POST /api/commerce/shop/products/bulk { action: live|hidden|archive|category, ids: uuid[1..100], category_id?: uuid|null }
//   One list action over the chosen products of the caller's account (admins). 200 { changed, skipped }: a product the
//   action does not fit (another account's id, not ready to go live, already in that state) is skipped, never an error.
export const runtime = 'nodejs';

import { bulkUpdateProducts } from '@/lib/commerce/catalogue/product-form';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../../_lib/http';

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json(await inTenant(caller, (tx) => bulkUpdateProducts(tx, caller.accountId, caller.userId, body)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
