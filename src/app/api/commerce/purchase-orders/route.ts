// GET  /api/commerce/purchase-orders — the latest purchase orders (agents and above). 200 { orders }.
// POST /api/commerce/purchase-orders { supplier_name, reference?, note?, lines: [{ variant_id, qty_ordered, unit_cost_minor }] }
//   A new draft in the store currency. Admins with commerce.inventory. 201 { order }; 409 store_not_configured, not_tracked.
export const runtime = 'nodejs';

import { createPurchaseOrder, listPurchaseOrders, parsePurchaseOrderInput } from '@/lib/commerce/purchase-orders';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../shop/_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent' });
    return json({ orders: await inTenant(caller, (tx) => listPurchaseOrders(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    return json({ order: await createPurchaseOrder(caller.tenant, parsePurchaseOrderInput(await readJson(request))) }, 201);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
