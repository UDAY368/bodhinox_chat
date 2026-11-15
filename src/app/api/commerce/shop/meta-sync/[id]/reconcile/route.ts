// POST /api/commerce/shop/meta-sync/<variant id>/reconcile (admins) — resolve an uncertain item: read it from Meta by its
//      retailer_id. Found: synced. Not found: not synced, and the next run creates it. 200 { status }.
//      409 conflict (not uncertain) / reconcile_too_soon / meta_not_connected; 502 meta_unavailable (it stays uncertain).
export const runtime = 'nodejs';

import { reconcileMetaItem } from '@/lib/commerce/catalogue/meta-sync-job';
import { CatalogueError, isId } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, json, mutationLimit, staffCaller, type IdContext } from '../../../_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const { id } = await context.params;
    if (!isId(id)) throw new CatalogueError('not_found');
    return json(await reconcileMetaItem({ ...caller.tenant, userId: caller.userId }, id));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
