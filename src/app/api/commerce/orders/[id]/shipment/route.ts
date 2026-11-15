// GET    /api/commerce/orders/[id]/shipment — the order's courier shipments and whether a courier is connected
//        (agents and above). 200 { connected, shipment: OrderShipmentView | null (the newest live one), shipments:
//        OrderShipmentView[] (each with the lines it carries), lines: [{ id, name, quantity, shipped }], defaults }.
// POST   /api/commerce/orders/[id]/shipment — creates a Shiprocket shipment for a paid order (commerce.shipments,
//        admin ceiling). Spends the Shiprocket wallet when the AWB is assigned. Body { length_cm, breadth_cm,
//        height_cm, weight_grams, provider? } (provider: shiprocket | delhivery | shipway; default = Shiprocket when
//        connected, else the first connected courier). Split shipments: items: [{ order_item_id, quantity }] names the
//        lines this parcel carries (without it: everything not yet in a live shipment), and weight_grams may be null to
//        take the weight of those items from the catalogue. 202 { shipmentId } (the job creates it); 409 shipment_exists
//        (nothing left to ship) | over_shipped (more than remains of a line) | order_not_paid | refund_in_flight |
//        address_incomplete; 503 not_connected | not_configured; 402 plan.
// DELETE /api/commerce/orders/[id]/shipment[?shipment_id=] — cancels the shipment (the newest live one, or the one
//        named) before pickup (commerce.shipments); the order stays as it is and the parcel's quantities are free
//        again. 200 { ok }; 409 conflict (picked up, or still being created).
// CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getCourierConnection } from '@/lib/fulfilment/connection';
import { getProviderConnections } from '@/lib/fulfilment/provider-connection';
import { getCourierProvider } from '@/lib/fulfilment/providers';
import { isCourierProviderId, type CourierProviderId } from '@/lib/fulfilment/providers/types';
import { cancelShipment, listOrderShipments, orderLinesShipped, requestShipment } from '@/lib/fulfilment/shipments';
import { shiprocketDisabled } from '@/lib/fulfilment/shiprocket-client';
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
        others: await getProviderConnections(tx, ctx.accountId),
        shipments: await listOrderShipments(tx, ctx.accountId, id),
        lines: (await orderLinesShipped(tx, ctx.accountId, id)).map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, shipped: l.shipped })),
      };
    });
    if (!loaded) return shipmentErrorResponse('not_found', 404);
    const { connection, shipments, lines, others } = loaded;
    const shipment = shipments[0] ?? null;
    const shiprocket = connection.connected && connection.status === 'active' && !shiprocketDisabled();
    // The connected couriers the admin may pick for a new shipment: Shiprocket first (the default), then the others.
    const couriers = [
      ...(shiprocket ? [{ id: 'shiprocket', name: 'Shiprocket', tested_live: true }] : []),
      ...(Array.isArray(others) ? others : []).filter((c) => c.connected && c.status === 'active' && c.available)
        .map((c) => ({ id: c.provider, name: getCourierProvider(c.provider).name, tested_live: false })),
    ];
    const first = couriers[0]?.id;
    const pick = first && first !== 'shiprocket' ? others.find((c) => c.provider === first) : null;
    const source = pick ?? connection;
    return NextResponse.json({
      connected: couriers.length > 0,
      shipment,
      shipments,
      lines,
      couriers,
      defaults: {
        length_cm: source.default_length_cm, breadth_cm: source.default_breadth_cm,
        height_cm: source.default_height_cm, weight_grams: source.default_weight_grams,
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
    const dims = { weight_grams: null } as { length_cm: number; breadth_cm: number; height_cm: number; weight_grams: number | null };
    for (const key of ['length_cm', 'breadth_cm', 'height_cm'] as const) {
      if (typeof body[key] !== 'number') return shipmentErrorResponse('invalid', 400);
      dims[key] = body[key] as number;
    }
    // Split shipments: the lines and quantities of this parcel (fixed shape; ids and whole numbers only).
    let items: Array<{ orderItemId: string; quantity: number }> | undefined;
    if (body.items !== undefined && body.items !== null) {
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) return shipmentErrorResponse('invalid', 400);
      items = [];
      for (const raw of body.items as unknown[]) {
        const item = raw as { order_item_id?: unknown; quantity?: unknown } | null;
        if (!item || typeof item !== 'object' || typeof item.order_item_id !== 'string' || !UUID.test(item.order_item_id)
          || typeof item.quantity !== 'number' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100_000)
          return shipmentErrorResponse('invalid', 400);
        items.push({ orderItemId: item.order_item_id.toLowerCase(), quantity: item.quantity });
      }
    }
    // The weight is typed by the admin, or (null with items) taken from the parcel's own items.
    if (typeof body.weight_grams === 'number') dims.weight_grams = body.weight_grams;
    else if (!(body.weight_grams === null && items)) return shipmentErrorResponse('invalid', 400);
    if (body.provider !== undefined && body.provider !== null && !isCourierProviderId(body.provider)) return shipmentErrorResponse('invalid', 400);
    const { shipmentId } = await requestShipment(actorOf(ctx), id, dims, (body.provider as CourierProviderId | null | undefined), items);
    return NextResponse.json({ shipmentId }, { status: 202, headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    if (!UUID.test(id)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('agent');
    const limited = writeLimit('shipments', ctx.userId);
    if (limited) return limited;
    const shipmentId = new URL(request.url).searchParams.get('shipment_id');
    if (shipmentId !== null && !UUID.test(shipmentId)) return shipmentErrorResponse('not_found', 404);
    await cancelShipment(actorOf(ctx), id, shipmentId);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
