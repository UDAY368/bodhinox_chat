// POST /api/commerce/shipments/bulk { action: 'create' | 'labels', order_ids: uuid[] (1-25) } — bulk dispatch from the
//   orders list (commerce.shipments, admin ceiling; agents and viewers get 403). Each order goes through the
//   single-order path on its own (lib/fulfilment/bulk-dispatch):
//   create: a courier shipment with the workspace's default parcel size; an order already handed to a courier
//     answers shipment_exists, so sending the same selection again never makes a second shipment.
//   labels: a short-lived label URL per order (https, never stored) once its AWB is assigned.
//   200 { results: [{ order_id, ok, shipment_id | url | code }] } in the order sent; 400 invalid; 409 no_defaults
//   (no default parcel size); 429. CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { bulkCreateShipments, bulkLabelUrls, parseBulkOrderIds } from '@/lib/fulfilment/bulk-dispatch';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limited = await writeLimit('shipments:bulk', ctx.userId);
    if (limited) return limited;
    const body = await jsonObject(request);
    const ids = parseBulkOrderIds(body?.order_ids);
    if (!body || !ids || (body.action !== 'create' && body.action !== 'labels')) return shipmentErrorResponse('invalid', 400);
    if (body.action === 'labels') return NextResponse.json({ results: await bulkLabelUrls(actorOf(ctx), ids) }, { headers: NO_STORE });
    const results = await bulkCreateShipments(actorOf(ctx), ids);
    if (results === 'no_defaults') return NextResponse.json({ code: 'no_defaults' }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ results }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
