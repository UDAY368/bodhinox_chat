// /api/analytics/saved-reports — saved report definitions (admins and owners).
//   GET   { reports: SavedReport[] } newest first, each with its email schedule.
//   POST  { name, metrics[], group, channel?, preset, from?, to?, format? }
//         saves one. metrics from new, resolved, first_response, resolution,
//         messages, failed; group day, week, channel, agent or label; channel
//         all (default), whatsapp or instagram; preset an analytics range
//         (custom needs from/to local days, at most 366); format csv (default)
//         or pdf. 201 { report }; 400 invalid (with `field`), 403 below admin,
//         409 name taken or 50 saved reports already, 429 too many requests.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { createSavedReport, listSavedReports } from '@/lib/analytics/saved-reports';
import { adminSession, readBody, savedReportErrorResponse } from './errors';

export async function GET(request: Request) {
  try {
    const { session, limited } = await adminSession(request, false);
    if (limited) return limited;
    return NextResponse.json({ reports: await listSavedReports(session) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { session, limited } = await adminSession(request, true);
    if (limited) return limited;
    const body = await readBody(request);
    try {
      return NextResponse.json({ report: await createSavedReport(session, body) }, { status: 201 });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
