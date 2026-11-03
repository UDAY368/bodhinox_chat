// GET /api/meta-ads/leads/export?formId&adId&from&to — admin: the matching
// leads as CSV. Needs the contact_export plan feature and the contacts.export
// permission; rate limited; audit-logged with the row count only.
import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { metaAdsConfig } from '@/lib/meta-ads/config';
import { exportLeadsCsv, parseLeadsFilter } from '@/lib/meta-ads/leads';
import { leadsErrorResponse, notEnabledResponse } from '@/lib/meta-ads/leads-http';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    if (!metaAdsConfig()) return notEnabledResponse();
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'contacts.export');
    // Admins are never masked; kept so a lower export role cannot leak numbers.
    if (await resolvePhoneMask(tenantOf(ctx))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const limit = checkRateLimit(`admin:metaLeadsExport:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const filter = parseLeadsFilter(new URL(request.url).searchParams);
    const { csv } = await exportLeadsCsv({ ...tenantOf(ctx), userId: ctx.userId }, filter);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="meta-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return leadsErrorResponse(error);
  }
}
