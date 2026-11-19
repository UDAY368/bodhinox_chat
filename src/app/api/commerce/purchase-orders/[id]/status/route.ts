// POST /api/commerce/purchase-orders/[id]/status { action: 'order' | 'cancel' | 'close' }
//   order: draft -> ordered. cancel: draft or ordered -> cancelled. close: partially received or received -> closed.
//   Admins with commerce.inventory. 200 { order }; 409 po_state.
export const runtime = 'nodejs';

import { changePurchaseOrderStatus, parsePoAction } from '@/lib/commerce/purchase-orders';
import { catalogueErrorResponse, json, mutationLimit, readJson, staffCaller, type IdContext } from '../../../shop/_lib/http';

export async function POST(request: Request, context: IdContext) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'commerce.inventory' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    return json({ order: await changePurchaseOrderStatus(caller.tenant, id, parsePoAction(await readJson(request))) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
