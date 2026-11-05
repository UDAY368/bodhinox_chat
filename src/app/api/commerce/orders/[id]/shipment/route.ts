// GET    /api/commerce/orders/[id]/shipment — the order's courier shipment and whether Shiprocket is connected
//        (agents and above). 200 { connected, shipment: OrderShipmentView | null, defaults }.
// POST   /api/commerce/orders/[id]/shipment — creates a Shiprocket shipment for a paid order (commerce.shipments,
//        admin ceiling). Spends the Shiprocket wallet when the AWB is assigned. Body { length_cm, breadth_cm,
//        height_cm, weight_grams }. 202 { shipmentId } (the job creates it); 409 shipment_exists | order_not_paid |
//        refund_in_flight | address_incomplete; 503 not_connected | not_configured; 402 plan.
// DELETE /api/commerce/orders/[id]/shipment — cancels the shipment before pickup (commerce.shipments); the order
//        stays paid. 200 { ok }; 409 conflict (picked up, or still being created).
// CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getCourierConnection } from '@/lib/fulfilment/connection';
import { cancelShipment, getOrderShipment, requestShipment } from '@/lib/fulfilment/shipments';
import { shiprocketDisabled } from '@/lib/fulfilment/shiprocket-client';
import type { ShipmentDims } from '@/lib/fulfilment/types';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    const loaded = await withTenant(tenantOf(ctx), async (tx) => {
      // An unknown or another workspace's order is not found, never "no shipment yet".
      const order = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
      if (!order.length) return null;
      return {
        connection: await getCourierConnection(tx, ctx.accountId),
        shipment: await getOrderShipment(tx, ctx.accountId, id),
      };
    });
    if (!loaded) return shipmentErrorResponse('not_found', 404);
    const { connection, shipment } = loaded;
    const connected = connection.connected && connection.status === 'active' && !shiprocketDisabled();
    return NextResponse.json({
      connected,
      shipment,
      defaults: {
        length_cm: connection.default_length_cm, breadth_cm: connection.default_breadth_cm,
        height_cm: connection.default_height_cm, weight_grams: connection.default_weight_grams,
      },
    }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    const limited = writeLimit('shipments', ctx.userId);
    if (limited) return limited;
    const body = await jsonObject(request);
    if (!body) return shipmentErrorResponse('invalid', 400);
    const dims = {} as ShipmentDims;
    for (const key of ['length_cm', 'breadth_cm', 'height_cm', 'weight_grams'] as const) {
      if (typeof body[key] !== 'number') return shipmentErrorResponse('invalid', 400);
      dims[key] = body[key] as number;
    }
    const { shipmentId } = await requestShipment(actorOf(ctx), id, dims);
    return NextResponse.json({ shipmentId }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    const limited = writeLimit('shipments', ctx.userId);
    if (limited) return limited;
    await cancelShipment(actorOf(ctx), id);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
