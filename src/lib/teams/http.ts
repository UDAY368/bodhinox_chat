import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { TeamError } from './teams';

const t = getT('Validation.teams');

export const noStore = { 'Cache-Control': 'private, no-store' };

/** A team validation error as { error, code } with its status; anything else is generic. */
export function teamError(error: unknown): NextResponse {
  if (error instanceof TeamError)
    return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status });
  return toErrorResponse(error);
}
