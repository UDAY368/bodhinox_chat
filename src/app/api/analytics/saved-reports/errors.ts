import { NextResponse } from 'next/server';

import { ForbiddenError } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { AnalyticsRangeError } from '@/lib/analytics/range';
import { SavedReportError } from '@/lib/analytics/saved-reports';
import { ScheduleError } from '@/lib/analytics/report-schedules';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.analytics');

const SAVED = {
  invalid: 'invalidSavedReport',
  duplicate_name: 'savedReportNameTaken',
  not_found: 'savedReportNotFound',
  too_many: 'tooManySavedReports',
} as const;
const SCHEDULE = {
  invalid: 'invalidSavedSchedule',
  invalid_recipients: 'invalidRecipients',
  not_found: 'scheduleNotFound',
  too_many: 'tooManySchedules',
  creator_lost_access: 'scheduleCreatorLostAccess',
} as const;

/** Maps a saved-report, schedule or range error to its translated response; rethrows anything else. */
export function savedReportErrorResponse(error: unknown): NextResponse {
  if (error instanceof SavedReportError)
    return NextResponse.json({ error: t(SAVED[error.code]), ...(error.issue ? { field: error.issue } : {}) }, { status: error.status });
  if (error instanceof ScheduleError) return NextResponse.json({ error: t(SCHEDULE[error.code]) }, { status: error.status });
  if (error instanceof AnalyticsRangeError) return NextResponse.json({ error: t('invalidRange') }, { status: 400 });
  throw error;
}

/** Signed in, admin or owner. Mutations also pass the origin/CSRF check and a per-member rate limit. */
export async function adminSession(request: Request, mutation: boolean) {
  const session = await requireSession(request);
  if (mutation) await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
  const limit = checkRateLimit(`analyticsSavedReports:${mutation ? 'write' : 'read'}:${session.userId}`, { limit: mutation ? 20 : 60, windowMs: 60_000 });
  return { session, limited: limit.success ? null : rateLimitResponse(limit) };
}

export const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};
