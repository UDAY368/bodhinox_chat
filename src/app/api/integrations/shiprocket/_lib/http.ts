// Shared helpers for the Shiprocket routes (settings and order shipments):
// private no-store responses, a per-member write limit, small JSON bodies and
// ShipmentError codes translated from Validation.shipments. Responses and logs
// carry codes only, never a provider message, a secret or an address.

import { NextResponse } from 'next/server';

import { toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { ShipmentError } from '@/lib/fulfilment/types';
import type { FulfilmentActor } from '@/lib/fulfilment/types';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

const t = getT('Validation.shipments');

export const actorOf = (ctx: AccountContext): FulfilmentActor => ({ ...tenantOf(ctx), userId: ctx.userId });

/** null when the member may write, else the 429 response. */
export function writeLimit(key: string, userId: string): NextResponse | null {
  const limit = checkRateLimit(`${key}:${userId}`, RATE_LIMITS.adminAction);
  return limit.success ? null : (rateLimitResponse(limit) as NextResponse);
}

/** A JSON object body of at most 16 KB, else null. */
export async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => '');
  if (text.length > 16_384) return null;
  try {
    const body = text ? JSON.parse(text) : {};
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function shipmentErrorResponse(code: ShipmentError['code'], status: number): NextResponse {
  return NextResponse.json({ error: t(code), code }, { status, headers: NO_STORE });
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ShipmentError) return shipmentErrorResponse(error.code, error.status);
  return toErrorResponse(error);
}
