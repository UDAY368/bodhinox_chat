// POST /api/analytics/saved-reports/[id]/duplicate — copies a saved report as
// "<name> copy" without its schedule (admins and owners). 201 { report };
// 404 unknown or another workspace's report; 409 at 50 saved reports.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { duplicateSavedReport } from '@/lib/analytics/saved-reports';
import { adminSession, savedReportErrorResponse } from '../../errors';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, limited } = await adminSession(request, true);
    if (limited) return limited;
    const { id } = await params;
    try {
      return NextResponse.json({ report: await duplicateSavedReport(session, id) }, { status: 201 });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
