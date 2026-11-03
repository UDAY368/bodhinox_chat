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
 * The period of the same length immediately before `range`, cut to the same
 * elapsed time (so "today so far" compares with "yesterday up to this hour").
 */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const startDay = addDays(range.startDay, -range.days);
  const from = localMidnight(startDay, range.timezone);
  const span = range.to.getTime() - range.from.getTime();
  const to = new Date(Math.min(from.getTime() + span, range.from.getTime()));
  return { ...range, preset: 'custom', startDay, endDay: addDays(range.startDay, -1), from, to };
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
