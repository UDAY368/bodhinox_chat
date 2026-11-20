// GET /api/commerce/purchase-orders/[id] — one purchase order with its lines (agents and above). 200 { order }.
// PUT /api/commerce/purchase-orders/[id] — replace a draft's details and lines. Admins with commerce.inventory.
//   200 { order }; 409 po_state (already ordered), not_tracked.
export const runtime = 'nodejs';

import { getPurchaseOrder, parsePurchaseOrderInput, updatePurchaseOrder } from '@/lib/commerce/purchase-orders';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../shop/_lib/http';

export async function GET(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ order: await inTenant(caller, (tx) => getPurchaseOrder(tx, caller.accountId, id)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function PUT(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    return json({ order: await updatePurchaseOrder(caller.tenant, id, parsePurchaseOrderInput(await readJson(request))) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
