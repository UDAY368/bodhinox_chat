// POST /api/commerce/purchase-orders/[id]/receive { request_key, location_id?, lines: [{ line_id, quantity }] }
//   Receive units into stock at a location (the default one when omitted). Admins with commerce.inventory; worker role; audited.
//   Written through lib/commerce/stock.ts, so the stock ledger and back-in-stock alerts follow as for a manual stock edit.
//   200 { order, replayed } (a repeated request_key changes nothing); 409 po_state, over_receive, key_reused, location_inactive.
export const runtime = 'nodejs';

import { parseReceiveInput, receivePurchaseOrder } from '@/lib/commerce/purchase-orders';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../shop/_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = await mutationLimit(caller);
    if (limited) return limited;
    return json(await receivePurchaseOrder(caller.tenant, id, parseReceiveInput(await readJson(request))));
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
