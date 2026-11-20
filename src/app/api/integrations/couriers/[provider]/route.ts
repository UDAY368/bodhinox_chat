// GET    /api/integrations/couriers/{provider} — the workspace's Delhivery or Shipway connection (any member; a viewer
//        sees "not connected"). { provider, available, tested_live: false, connected, status, label, secret_hint,
//        pickup_location, default_*, last_error_code, connected_at }. Never the secret (a masked hint only).
// PUT    /api/integrations/couriers/{provider} — connect or update (admin + commerce.shipments) after the courier
//        accepts the credentials. Body { label, secret?, pickup_location?, defaults: {...} }; a blank secret keeps the
//        stored one for the same label.
// DELETE /api/integrations/couriers/{provider} — disconnect (admin + commerce.shipments); clears the stored secret.
// {provider} is delhivery or shipway (Shiprocket keeps /api/integrations/shiprocket). Both couriers are NOT TESTED
// AGAINST THE LIVE API YET. Errors: { error, code } with Validation.shipments codes. CSRF: session mutations pass
// the proxy's assertMutation.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { disconnectProvider, getProviderConnection, saveProviderConnection } from '@/lib/fulfilment/provider-connection';
import { isSecretCourierId } from '@/lib/fulfilment/providers/types';
import type { ShipmentDims } from '@/lib/fulfilment/types';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ provider: string }> };
const DIM_KEYS = ['length_cm', 'breadth_cm', 'height_cm', 'weight_grams'] as const;

export async function GET(_request: Request, context: Context) {
  try {
    const { provider } = await context.params;
    if (!isSecretCourierId(provider)) return shipmentErrorResponse('not_found', 404);
    const ctx = await getCurrentAccount();
    const connection = await withTenant(tenantOf(ctx), (tx) => getProviderConnection(tx, ctx.accountId, provider));
    return NextResponse.json(connection, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { provider } = await context.params;
    if (!isSecretCourierId(provider)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('admin');
    const limited = await writeLimit('courierSettings', ctx.userId);
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
    const optional = (v: unknown) => v === undefined || v === null || typeof v === 'string';
    if (typeof body.label !== 'string' || !optional(body.secret) || !optional(body.pickup_location)) return shipmentErrorResponse('invalid', 400);
    const connection = await saveProviderConnection(actorOf(ctx), provider, {
      label: body.label, secret: (body.secret as string | null | undefined) ?? null,
      pickup_location: (body.pickup_location as string | null | undefined) ?? null, defaults,
    });
    return NextResponse.json(connection, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { provider } = await context.params;
    if (!isSecretCourierId(provider)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('admin');
    const limited = await writeLimit('courierSettings', ctx.userId);
    if (limited) return limited;
    await disconnectProvider(actorOf(ctx), provider);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
