// GET /api/commerce/orders/[id]/shipment/label — a short-lived Shiprocket label URL for the shipment's AWB
//   (commerce.shipments). 200 { url } (https only, never stored); 409 conflict when no AWB yet;
//   502 provider_unreachable; 503 not_configured / not_connected.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { labelUrl } from '@/lib/fulfilment/shipments';
import { actorOf, errorResponse, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    // A provider call per request: the write limit applies.
    const limited = writeLimit('shipments', ctx.userId);
    if (limited) return limited;
    const url = await labelUrl(actorOf(ctx), id);
    return NextResponse.json({ url }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
