// GET /api/payments/reconciliation?from=YYYY-MM-DD&to=YYYY-MM-DD — per local day
// and currency: money captured (gateway and staff-recorded), refunds processed
// (ours and Razorpay dashboard refunds) and net, plus open exceptions and
// refunds whose outcome is unknown. Admin and above. Defaults to the last 30 days.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { addDays, localDay, workspaceTimezone } from '@/lib/analytics/range';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { reconciliationReport, ReportRangeError } from '@/lib/payments/queries';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const params = new URL(request.url).searchParams;
    const report = await withTenant(tenantOf(ctx), async (tx) => {
      const today = localDay(new Date(), await workspaceTimezone(tx, ctx.accountId));
      const to = params.get('to') || today;
      const from = params.get('from') || addDays(to, -29);
      return reconciliationReport(tx, ctx.accountId, { from, to });
    });
    return NextResponse.json({ report }, { headers });
  } catch (error) {
    if (error instanceof ReportRangeError || (error instanceof Error && error.name === 'AnalyticsRangeError'))
      return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    return toErrorResponse(error);
  }
}
