// /api/analytics/saved-reports/[id] — one saved report (admins and owners).
//   PATCH  the full definition (as POST /api/analytics/saved-reports): 200 { report }.
//          Its email schedule keeps its timing and takes the new file type.
//   DELETE removes it and its email schedule: 204.
// 404 unknown or another workspace's report; 409 name taken.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { deleteSavedReport, updateSavedReport } from '@/lib/analytics/saved-reports';
import { adminSession, readBody, savedReportErrorResponse } from '../errors';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { session, limited } = await adminSession(request, true);
    if (limited) return limited;
    const { id } = await params;
    const body = await readBody(request);
    try {
      return NextResponse.json({ report: await updateSavedReport(session, id, body) });
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
      await deleteSavedReport(session, id);
      return new Response(null, { status: 204 });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
