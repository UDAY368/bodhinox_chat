// POST /api/integrations/couriers/{provider}/test — checks the given (or stored) credentials with Delhivery or
//   Shipway without saving anything (admin + commerce.shipments). Body { label, secret? }; without a secret the
//   stored one is used. 200 { ok: true }; 400 auth/invalid; 502 provider_unreachable; 503 not_configured.
//   NOT TESTED AGAINST THE LIVE API YET.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { testProviderConnection } from '@/lib/fulfilment/provider-connection';
import { isSecretCourierId } from '@/lib/fulfilment/providers/types';
import { actorOf, errorResponse, jsonObject, NO_STORE, shipmentErrorResponse, writeLimit } from '@/app/api/integrations/shiprocket/_lib/http';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await context.params;
    if (!isSecretCourierId(provider)) return shipmentErrorResponse('not_found', 404);
    const ctx = await requireRole('admin');
    const limited = writeLimit('courierSettings', ctx.userId);
    if (limited) return limited;
    const body = await jsonObject(request);
    if (!body) return shipmentErrorResponse('invalid', 400);
    const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? null : undefined);
    const label = text(body.label);
    const secret = text(body.secret);
    if (label === undefined || secret === undefined) return shipmentErrorResponse('invalid', 400);
    await testProviderConnection(actorOf(ctx), provider, { label, secret });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
