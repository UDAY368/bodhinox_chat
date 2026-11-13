// GET /api/analytics/saved-reports/[id]/export?format=csv|pdf — builds the
// report now and sends the file (admins and owners). The export is
// audit-logged in the same transaction as its query; the file is never stored
// or cached. format defaults to the report's own file type. 400 bad format,
// 404 unknown or another workspace's report.

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { reportContentType } from '@/lib/analytics/report-storage';
import { exportSavedReport } from '@/lib/analytics/saved-reports';
import { getT } from '@/lib/i18n/translate';
import { adminSession, savedReportErrorResponse } from '../../errors';

const t = getT('Validation.analytics');

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, limited } = await adminSession(request, false);
    if (limited) return limited;
    const { id } = await params;
    const asked = new URL(request.url).searchParams.get('format');
    if (asked !== null && asked !== 'csv' && asked !== 'pdf')
      return NextResponse.json({ error: t('invalidFormat') }, { status: 400 });
    try {
      const file = await exportSavedReport(session, id, asked ?? undefined);
      return new Response(file.bytes as unknown as BodyInit, {
        headers: {
          'Content-Type': reportContentType(file.format),
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return savedReportErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
