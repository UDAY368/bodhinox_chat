// GET    /api/integrations/shiprocket — the workspace's Shiprocket connection (any member; a viewer sees
//        "not connected"). { connected, status, api_email, pickup_location, default_*, webhook_url,
//        webhook_token_set, available }. Never a password, token or webhook token.
// PUT    /api/integrations/shiprocket — connect or update (admin + commerce.shipments) after Shiprocket
//        accepts the login and lists the chosen pickup location. Body { email, password?, pickup_location,
//        defaults: { length_cm?, breadth_cm?, height_cm?, weight_grams? } }; a blank password keeps the stored one.
// DELETE /api/integrations/shiprocket — disconnect (admin + commerce.shipments); clears every stored secret.
// Errors: { error, code } with Validation.shipments codes (400 auth/invalid, 402 plan, 502 provider_unreachable,
// 503 not_configured). CSRF: session mutations pass the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { disconnectCourier, getCourierConnection, saveCourierConnection } from '@/lib/fulfilment/connection';
import { shiprocketDisabled } from '@/lib/fulfilment/shiprocket-client';
import type { ShipmentDims } from '@/lib/fulfilment/types';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from './_lib/http';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const connection = await withTenant(tenantOf(ctx), (tx) => getCourierConnection(tx, ctx.accountId));
    return NextResponse.json({ ...connection, available: !shiprocketDisabled() }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

const DIM_KEYS = ['length_cm', 'breadth_cm', 'height_cm', 'weight_grams'] as const;

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limited = writeLimit('shiprocketSettings', ctx.userId);
    if (limited) return limited;
    const body = await jsonObject(request);
    if (!body) return shipmentErrorResponse('invalid', 400);
    const defaultsRaw = body.defaults ?? {};
    if (typeof defaultsRaw !== 'object' || defaultsRaw === null || Array.isArray(defaultsRaw)) return shipmentErrorResponse('invalid', 400);
    const defaults: Partial<ShipmentDims> = {};
    for (const key of DIM_KEYS) {
      const v = (defaultsRaw as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'number') return shipmentErrorResponse('invalid', 400);
      defaults[key] = v;
    }
    if (typeof body.email !== 'string' || typeof body.pickup_location !== 'string'
      || (body.password !== undefined && body.password !== null && typeof body.password !== 'string')) return shipmentErrorResponse('invalid', 400);
    const connection = await saveCourierConnection(actorOf(ctx), {
      email: body.email, password: (body.password as string | null | undefined) ?? null, pickup_location: body.pickup_location, defaults,
    });
    return NextResponse.json({ ...connection, available: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('admin');
    const limited = writeLimit('shiprocketSettings', ctx.userId);
    if (limited) return limited;
    await disconnectCourier(actorOf(ctx));
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
