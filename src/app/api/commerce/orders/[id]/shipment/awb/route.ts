// POST /api/commerce/orders/[id]/shipment/awb — "Assign courier again" after Shiprocket definitely refused the
//   AWB (commerce.shipments). Never after an ambiguous assignment, which could already have charged the wallet.
//   202 { ok }; 409 conflict | order_not_paid | refund_in_flight; 503 not_configured.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { reassignAwb } from '@/lib/fulfilment/shipments';
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
    await reassignAwb(actorOf(ctx), id);
    return NextResponse.json({ ok: true }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
