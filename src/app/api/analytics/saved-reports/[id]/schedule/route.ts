// /api/analytics/saved-reports/[id]/schedule — email a saved report (admins and owners).
//   PUT    { cadence: daily|weekly|monthly, hour_local: 0-23, minute_local: 0-59,
//            recipients: userId[] } creates or changes the schedule. Each
//            email covers the period that just ended; 1-10 recipients, each a
//            current admin or owner (checked again at every send). 200 { report }.
//   DELETE stops sending (removes the schedule): 200 { report }.
// 400 invalid, 404 unknown report or no schedule, 409 at 10 schedules.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { removeSavedReportSchedule, setSavedReportSchedule } from '@/lib/analytics/saved-reports';
import { adminSession, readBody, savedReportErrorResponse } from '../../errors';

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Context) {
  try {
    const { session, limited } = await adminSession(request, true);
    if (limited) return limited;
    const { id } = await params;
    const body = (await readBody(request)) ?? {};
    try {
      const report = await setSavedReportSchedule(session, id, {
        cadence: body.cadence, hourLocal: body.hour_local, minuteLocal: body.minute_local, recipients: body.recipients,
      });
      return NextResponse.json({ report });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const { session, limited } = await adminSession(request, true);
    if (limited) return limited;
    const { id } = await params;
    try {
      return NextResponse.json({ report: await removeSavedReportSchedule(session, id) });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
