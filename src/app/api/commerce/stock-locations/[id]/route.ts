// PATCH /api/commerce/stock-locations/[id] { name?, active? } — rename a location or turn it on or off.
//   Admins with commerce.inventory. 200 { location }; 409 location_in_use (the default location, or one that still holds stock), name_taken.
export const runtime = 'nodejs';

import { updateLocation } from '@/lib/commerce/stock-locations';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../shop/_lib/http';
import { revalidateShop } from '@/lib/commerce/shop-cache';

export async function PATCH(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    const location = await updateLocation(caller.tenant, id, await readJson(request));
    revalidateShop(caller.accountId);
    return json({ location });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
