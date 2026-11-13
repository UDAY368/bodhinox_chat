// GET /api/analytics/saved-reports/[id]/preview — the report's rows for its
// range, resolved now in the workspace timezone (admins and owners):
// { group, metrics, rows: [{ key, name, values }], range }. Durations are in
// seconds. 404 unknown or another workspace's report.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { previewSavedReport } from '@/lib/analytics/saved-reports';
import { adminSession, savedReportErrorResponse } from '../../errors';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, limited } = await adminSession(request, false);
    if (limited) return limited;
    const { id } = await params;
    try {
      return NextResponse.json({ preview: await previewSavedReport(session, id) }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
