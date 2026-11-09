// POST /api/commerce/orders/[id]/shipment/pickup — "Request pickup again" after Shiprocket did not schedule the
//   pickup of a shipment whose AWB is assigned (commerce.shipments). A pickup request charges nothing.
//   200 { ok }; 409 conflict | order_refunded; 502 provider_unreachable; 503 not_configured.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { retryPickup } from '@/lib/fulfilment/shipments';
import { actorOf, errorResponse, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    const limited = writeLimit('shipments', ctx.userId);
    if (limited) return limited;
    await retryPickup(actorOf(ctx), id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
