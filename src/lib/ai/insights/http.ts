import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { InsightError } from './runs';

const t = getT('AiInsights.errors');

/** Refusals carry a stable `code` and a translated `error`; anything unexpected is a generic 500. */
export function insightErrorResponse(error: unknown): NextResponse {
  if (error instanceof InsightError) return NextResponse.json({ error: t(error.code), code: error.code }, { status: error.status });
  return toErrorResponse(error);
}
