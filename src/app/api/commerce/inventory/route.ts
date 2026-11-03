// GET /api/commerce/inventory?q=&filter=low|out&limit=&offset= — tracked, active variants with on hand, reserved,
//   available and the low-stock threshold, lowest first (agents and above). 200 { items, total }.
export const runtime = 'nodejs';

import { listInventory, parseInventoryQuery } from '@/lib/commerce/catalogue/inventory';
import { catalogueErrorResponse, inTenant, json, staffCaller } from '../shop/_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    const query = parseInventoryQuery(new URL(request.url).searchParams);
    return json(await inTenant(caller, (tx) => listInventory(tx, caller.accountId, query)));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
