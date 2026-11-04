import { NextResponse } from 'next/server';

import { ShareError } from '@/lib/analytics/report-shares';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.analytics');

const MESSAGES = {
  invalid: 'invalidShare',
  role_too_low: 'shareRoleTooLow',
  not_found: 'reportNotFound',
  not_ready: 'reportNotReady',
} as const;

/** Maps a ShareError to its translated response; rethrows anything else. */
export function shareErrorResponse(error: unknown): NextResponse {
  if (!(error instanceof ShareError)) throw error;
  return NextResponse.json({ error: t(MESSAGES[error.code]) }, { status: error.status });
}
