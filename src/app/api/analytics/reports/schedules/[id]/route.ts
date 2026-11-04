// /api/analytics/reports/schedules/[id] — one report schedule (admins and owners).
//   PATCH  { paused?, recipients?, hour_local?, cadence?, format? }: pause or
//          resume, or change delivery. Resuming a schedule paused because its
//          creator lost admin access is refused (409) while that is still true.
//   DELETE removes it (runs it produced are kept until they expire).
// 404 unknown or another workspace's schedule.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { deleteSchedule, updateSchedule } from '@/lib/analytics/report-schedules';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { scheduleErrorResponse } from '../errors';

type Context = { params: Promise<{ id: string }> };

async function guard(request: Request) {
  const session = await requireSession(request);
  await assertMutation(request, session);
  if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
  const limit = checkRateLimit(`analyticsReportSchedules:${session.userId}`, { limit: 10, windowMs: 60_000 });
  return { session, limited: limit.success ? null : rateLimitResponse(limit) };
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { session, limited } = await guard(request);
    if (limited) return limited;
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return scheduleErrorResponse('invalid');
      const schedule = await updateSchedule(session, id, {
        paused: body.paused, recipients: body.recipients, hourLocal: body.hour_local, cadence: body.cadence, format: body.format,
      });
      return NextResponse.json({ schedule });
    } catch (error) {
      return scheduleErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const { session, limited } = await guard(request);
    if (limited) return limited;
    const { id } = await params;
    try {
      await deleteSchedule(session, id);
      return new Response(null, { status: 204 });
    } catch (error) {
      return scheduleErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
