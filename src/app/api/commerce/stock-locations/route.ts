// GET  /api/commerce/stock-locations?variant_id= — every stock location with the units it holds (agents and above).
//   With variant_id: that variant's quantity at each location instead. 200 { locations } | { quantities }.
// POST /api/commerce/stock-locations { name } — add a location. Admins with commerce.inventory. 201 { location }; 409 name_taken.
export const runtime = 'nodejs';

import { createLocation, listLocations, variantLocations } from '@/lib/commerce/stock-locations';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller } from '../shop/_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    const variantId = new URL(request.url).searchParams.get('variant_id');
    if (variantId) return json({ quantities: await variantLocations(caller.tenant, variantId) });
    return json({ locations: await listLocations(caller.tenant) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    return json({ location: await createLocation(caller.tenant, await readJson(request)) }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
