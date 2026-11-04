// /api/analytics/reports/schedules — scheduled report delivery (admins and owners).
//   GET   { schedules: ReportSchedule[] }.
//   POST  { kind, format?, cadence, hour_local?, recipients: userId[] } creates
//         one. cadence is daily, weekly (Monday) or monthly (the 1st);
//         hour_local 0-23 in the workspace timezone (default 8); 1-10
//         recipients, each a current admin or owner. At most 10 per workspace.
//         201 { schedule }; 400 invalid input, 403 below admin, 409 at the
//         limit, 429 too many requests.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { createSchedule, listSchedules } from '@/lib/analytics/report-schedules';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { scheduleErrorResponse } from './errors';

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    return NextResponse.json({ schedules: await listSchedules(session) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`analyticsReportSchedules:${session.userId}`, { limit: 10, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return scheduleErrorResponse('invalid');
      const schedule = await createSchedule(session, {
        kind: body.kind, format: body.format, cadence: body.cadence, hourLocal: body.hour_local, recipients: body.recipients,
      });
      return NextResponse.json({ schedule }, { status: 201 });
    } catch (error) {
      return scheduleErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
