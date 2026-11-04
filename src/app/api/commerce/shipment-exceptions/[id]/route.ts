// POST /api/commerce/shipment-exceptions/{id} { resolution } — admin with
// commerce.shipments. accept_correction (contradiction only) moves the
// shipment to the observed status and never changes the order (use Returns);
// recreate (ambiguous create or AWB only) frees the order for a new shipment;
// dismiss / manual close it. Audited. Session CSRF by the proxy (assertMutation).
// 200 { exception }; 400 invalid; 404 not_found; 409 conflict (already resolved).

import { NextResponse } from 'next/server';

import { resolveShipmentException } from '@/lib/fulfilment/exceptions';
import { SHIPMENT_EXCEPTION_RESOLUTIONS, ShipmentError, type ShipmentExceptionResolution } from '@/lib/fulfilment/types';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { NO_STORE, shipmentAdmin, shipmentErrorResponse } from '../_lib/http';

export const runtime = 'nodejs';

const LIMIT = { limit: 30, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

async function readResolution(request: Request): Promise<ShipmentExceptionResolution | null> {
  try {
    const text = await request.text();
    if (text.length > 4096) return null;
    const body: unknown = JSON.parse(text);
    const value = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).resolution : null;
    return (SHIPMENT_EXCEPTION_RESOLUTIONS as readonly unknown[]).includes(value) ? (value as ShipmentExceptionResolution) : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await shipmentAdmin();
    const limit = checkRateLimit(`shipmentException:${actor.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await context.params;
    const resolution = await readResolution(request);
    if (!resolution) throw new ShipmentError('invalid');
    const exception = await resolveShipmentException(actor, id, resolution);
    return NextResponse.json({ exception }, { headers: NO_STORE });
  } catch (error) {
    return shipmentErrorResponse(error);
  }
}
