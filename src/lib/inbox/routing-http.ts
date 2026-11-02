import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { RoutingRuleError } from '@/lib/inbox/routing';

const t = getT('Validation.routingRules');

export const noStore = { 'Cache-Control': 'private, no-store' };

/** A rule validation error as { error, code } with its status; anything else is generic. */
export function routingError(error: unknown): NextResponse {
  if (error instanceof RoutingRuleError)
    return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status });
  return toErrorResponse(error);
}
