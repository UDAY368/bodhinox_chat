// Error envelopes for the billing routes: stable codes with translated text,
// never provider error text.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { ProfileInputError } from './profile';
import { BillingError } from './subscriptions';

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export function billingErrorResponse(error: unknown): NextResponse {
  const t = getT('Validation.billing');
  if (error instanceof BillingError)
    return NextResponse.json({ error: t(error.billingCode), code: error.billingCode }, { status: error.status, headers: NO_STORE });
  if (error instanceof ProfileInputError)
    return NextResponse.json({ error: t(error.code), code: error.code }, { status: 400, headers: NO_STORE });
  return toErrorResponse(error);
}

export const badRequest = (code: 'invalid_request') =>
  NextResponse.json({ error: getT('Validation.billing')(code), code }, { status: 400, headers: NO_STORE });

/** The JSON object body, or null. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
