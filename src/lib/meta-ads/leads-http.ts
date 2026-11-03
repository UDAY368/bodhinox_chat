// Shared responses for the /api/meta-ads/leads routes.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { LeadsInputError } from './leads';

export const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** 503 before any DB or Graph work while the feature is off or unconfigured. */
export function notEnabledResponse(): NextResponse {
  return NextResponse.json({ error: 'meta_ads_not_enabled', message: getT('Api.metaAds')('notEnabled') }, { status: 503, headers: NO_STORE });
}

export function leadsErrorResponse(error: unknown): NextResponse {
  if (error instanceof LeadsInputError) {
    const tooMany = error.message === 'too_many';
    return NextResponse.json(
      { error: tooMany ? 'too_many_rows' : 'invalid_request', message: getT('Api.metaAds')(tooMany ? 'exportTooLarge' : 'invalidRequest') },
      { status: 400, headers: NO_STORE },
    );
  }
  return toErrorResponse(error);
}
