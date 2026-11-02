// GET /api/whatsapp/forms/[id]/responses/export — every response as CSV, one column
// per question. Admin only (bulk personal data), rate limited and audit-logged
// like the contact export; cells are formula-safe.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { exportResponsesCsv, formErrorResponse } from '@/lib/whatsapp/forms/service';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:formResponsesExport:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { csv } = await exportResponsesCsv(tenantOf(ctx), id);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // The form name is user text, so the filename carries only the date.
        'Content-Disposition': `attachment; filename="form-responses-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return formErrorResponse(error);
  }
}
