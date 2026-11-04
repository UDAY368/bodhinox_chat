// Shared handler for the read-only analytics report routes
// (/api/analytics/{overview,agents,campaigns,flows,ai}).
//
// Every report: a live session, the route's minimum role from the current
// membership, a per-user rate limit (reports are heavy aggregate scans), one
// tenant transaction with a statement timeout (runAnalytics), and a range
// parsed in the workspace timezone (at most 366 days). Responses are never
// cached and carry counts, durations and workspace labels only.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { AnalyticsInputError, runAnalytics } from './queries';
import {
  addDays,
  AnalyticsRangeError,
  dayCount,
  localMidnight,
  parseRange,
  rangeInputFromSearchParams,
  type AnalyticsRange,
} from './range';

const t = getT('Validation.analytics');

/** Report requests per member per minute. A page load issues five. */
export const ANALYTICS_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

export interface ReportContext {
  tx: TenantTransaction;
  accountId: string;
  range: AnalyticsRange;
  params: URLSearchParams;
}

/** The range as echoed to the browser (no Date objects). */
export function rangeSummary(range: AnalyticsRange) {
  return {
    preset: range.preset,
    startDay: range.startDay,
    endDay: range.endDay,
    days: range.days,
    timezone: range.timezone,
    bucket: range.bucket,
  };
}

/**
 * The period to compare `range` with, cut to the same elapsed time (so
 * "today so far" compares with "yesterday up to this hour"). Rolling and
 * custom ranges take the period of the same length immediately before.
 * Calendar presets take the previous calendar period: the week before
 * (Monday start), or the month before from its 1st, as many days as the
 * range has but never past that month's end (October compares with all of
 * September; 4 days into November with 1-4 October).
 */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  let startDay: string, endDay: string;
  if (range.preset === 'this_month' || range.preset === 'last_month') {
    const monthBeforeEnd = addDays(`${range.startDay.slice(0, 7)}-01`, -1);
    startDay = `${monthBeforeEnd.slice(0, 7)}-01`;
    const sameLength = addDays(startDay, range.days - 1);
    endDay = sameLength < monthBeforeEnd ? sameLength : monthBeforeEnd;
  } else if (range.preset === 'this_week' || range.preset === 'last_week') {
    startDay = addDays(range.startDay, -7);
    endDay = addDays(startDay, range.days - 1);
  } else {
    startDay = addDays(range.startDay, -range.days);
    endDay = addDays(range.startDay, -1);
  }
  const from = localMidnight(startDay, range.timezone);
  const dayEnd = localMidnight(addDays(endDay, 1), range.timezone);
  const span = range.to.getTime() - range.from.getTime();
  const to = new Date(Math.min(from.getTime() + span, dayEnd.getTime()));
  return { ...range, preset: 'custom', startDay, endDay, days: dayCount(startDay, endDay), from, to };
}

export async function analyticsReport<T extends object>(
  request: Request,
  minimum: AccountRole,
  report: (context: ReportContext) => Promise<T>,
): Promise<NextResponse> {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, minimum)) throw new ForbiddenError('Insufficient workspace role');
    const limit = checkRateLimit(`analytics:${session.userId}`, ANALYTICS_RATE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const params = new URL(request.url).searchParams;
    const body = await runAnalytics(
      { accountId: session.accountId, userId: session.userId, role: session.role },
      async (tx, timezone) => {
        const range = parseRange(rangeInputFromSearchParams(params), timezone);
        return { range: rangeSummary(range), ...(await report({ tx, accountId: session.accountId, range, params })) };
      },
    );
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof AnalyticsRangeError)
      return NextResponse.json({ error: t('invalidRange') }, { status: 400 });
    if (error instanceof AnalyticsInputError)
      return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    return toErrorResponse(error);
  }
}
