// POST /api/integrations/shiprocket/test — checks API user details with Shiprocket and returns the
//   account's pickup locations, without saving anything (admin + commerce.shipments). Body
//   { email?, password? }; without a password the stored details are used. 200 { pickup_locations };
//   400 auth/invalid; 502 provider_unreachable; 503 not_configured / not_connected.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { listPickupLocations } from '@/lib/fulfilment/connection';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from '../_lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limited = writeLimit('shiprocketSettings', ctx.userId);
    if (limited) return limited;
    const body = await jsonObject(request);
    if (!body) return shipmentErrorResponse('invalid', 400);
    const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? null : undefined);
    const email = text(body.email);
    const password = text(body.password);
    if (email === undefined || password === undefined) return shipmentErrorResponse('invalid', 400);
    const pickupLocations = await listPickupLocations(actorOf(ctx), { email, password });
    return NextResponse.json({ pickup_locations: pickupLocations }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
