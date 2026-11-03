// PATCH /api/commerce/shop/categories/[id] { name?, parent_id?, position?, archived? } (admins). 200 { category }.
//   409 category_depth / category_has_children keep the tree two levels deep.
export const runtime = 'nodejs';

import { CatalogueError, isId, updateCategory } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../_lib/http';

export async function PATCH(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    if (!isId(id)) throw new CatalogueError('not_found');
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ category: await inTenant(caller, (tx) => updateCategory(tx, caller.accountId, caller.userId, id, body)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
