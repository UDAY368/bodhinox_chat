// /api/analytics/reports — downloadable CSV or PDF reports (admins and owners).
//   GET   the workspace's latest 50 reports: { reports: ReportRun[] }.
//   POST  { kind, format?, preset?, from?, to?, email? } requests one; the row
//         and its worker job commit before the 202 { report }. kind is one of
//         campaign_daily, campaign_summary, member_campaigns, agent_performance,
//         product_summary, service_summary, commerce_daily; format is csv
//         (default) or pdf; the range follows the analytics presets (today,
//         7d, 30d, 90d, this/last week or month, or custom from/to local days,
//         at most 366 days). email asks for a
//         sign-in link by email when the file is ready. 400 invalid input,
//         403 below admin, 429 too many queued reports or requests.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { AnalyticsRangeError } from '@/lib/analytics/range';
import { listReports, ReportError, requestReport } from '@/lib/analytics/reports';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.analytics');

const text = (value: unknown) => (typeof value === 'string' && value.length <= 32 ? value : null);

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    return NextResponse.json({ reports: await listReports(session) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`analyticsReports:${session.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
    if (body.email !== undefined && typeof body.email !== 'boolean')
      return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
    try {
      const report = await requestReport(session, {
        kind: body.kind,
        range: { preset: text(body.preset), from: text(body.from), to: text(body.to) },
        email: body.email === true,
        format: body.format,
      });
      return NextResponse.json({ report }, { status: 202 });
    } catch (error) {
      if (error instanceof AnalyticsRangeError) return NextResponse.json({ error: t('invalidRange') }, { status: 400 });
      if (error instanceof ReportError && error.code === 'invalid_kind')
        return NextResponse.json({ error: t('invalidReport') }, { status: 400 });
      if (error instanceof ReportError && error.code === 'invalid_format')
        return NextResponse.json({ error: t('invalidFormat') }, { status: 400 });
      if (error instanceof ReportError && error.code === 'too_many_pending')
        return NextResponse.json({ error: t('tooManyReports') }, { status: 429 });
      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
