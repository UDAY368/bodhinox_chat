// Shared response helpers for the Instagram routes (Phase 11). Every response
// is private and uncached; errors carry a fixed code plus a translated message
// (Api.instagram.*), never Meta's text.
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { InstagramError, type InstagramErrorCode } from './errors';

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

const t = getT('Api.instagram');

export function instagramErrorResponse(code: InstagramErrorCode): NextResponse {
  const error = new InstagramError(code);
  return NextResponse.json({ error: code, message: t(code) }, { status: error.status, headers: NO_STORE });
}

/** 503 instagram_not_enabled: answered before any DB write or Instagram call. */
export const notEnabledResponse = () => instagramErrorResponse('instagram_not_enabled');

/** InstagramError -> its fixed code; auth errors -> 401/403; anything else -> 500 (logged by name only). */
export function instagramRouteError(error: unknown): NextResponse {
  if (error instanceof InstagramError) return instagramErrorResponse(error.code);
  return toErrorResponse(error);
}
