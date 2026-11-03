// GET /api/whatsapp/forms/[id]/responses/export — every response as CSV, one column
// per question. Admin only (bulk personal data), rate limited and audit-logged
// like the contact export; cells are formula-safe. Like the contact and Meta-leads
// exports it needs the contacts.export permission (403) and the contact_export
// plan feature (402).

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant } from '@/lib/db/tenant';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { exportResponsesCsv, formErrorResponse } from '@/lib/whatsapp/forms/service';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'contacts.export');
    await withTenant(tenantOf(ctx), (tx) => requireFeature(tx, ctx.accountId, 'contact_export'));
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
