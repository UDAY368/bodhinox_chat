// Shared response helpers for the /api/meta-ads routes. Every response is
// private and uncached; errors carry a fixed code plus a translated message,
// never Meta's text.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import type { AuthContext } from '@/lib/auth/session';
import { getT } from '@/lib/i18n/translate';
import { MetaAdsError, type MetaAdsActor, type MetaAdsErrorCode } from './connection';

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

const t = getT('Api.metaAds');
const MESSAGE: Record<MetaAdsErrorCode, string> = {
  meta_ads_not_enabled: 'notEnabled',
  forbidden: 'forbidden',
  invalid_request: 'invalidRequest',
  not_connected: 'notConnected',
  already_connected: 'alreadyConnected',
  page_in_use: 'pageInUse',
  token_invalid: 'tokenInvalid',
  invalid_choice: 'invalidChoice',
  invalid_number: 'invalidNumber',
  missing_scope: 'missingScope',
  revoke_failed: 'revokeFailed',
  meta_error: 'metaError',
  rate_limited: 'rateLimited',
};

export function metaAdsErrorResponse(code: MetaAdsErrorCode): NextResponse {
  const error = new MetaAdsError(code);
  return NextResponse.json({ error: code, message: t(MESSAGE[code]) }, { status: error.status, headers: NO_STORE });
}

/** 503 meta_ads_not_enabled: answered before any DB write or Graph call. */
export const notEnabledResponse = () => metaAdsErrorResponse('meta_ads_not_enabled');

/** MetaAdsError -> its fixed code; auth errors -> 401/403; anything else -> 500 (logged by name only). */
export function metaAdsRouteError(error: unknown): NextResponse {
  if (error instanceof MetaAdsError) return metaAdsErrorResponse(error.code);
  return toErrorResponse(error);
}

export const actorOf = (session: Pick<AuthContext, 'accountId' | 'userId' | 'role'>): MetaAdsActor => ({
  accountId: session.accountId,
  userId: session.userId,
  role: session.role,
});
