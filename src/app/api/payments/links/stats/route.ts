// GET /api/payments/links/stats — totals for the Payments summary cards (agent and above): per currency, the count and
//   amount of paid links, links still waiting to be paid, and links that closed unpaid (expired, cancelled, failed);
//   and the number of links in each status. 200 { stats: PaymentLinkStatsRow[], by_status: { [status]: count } }.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { paymentLinkStats, paymentLinkStatusCounts } from '@/lib/payments/links';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const { stats, byStatus } = await withTenant(tenantOf(ctx), async (tx) => ({
      stats: await paymentLinkStats(tx, ctx.accountId),
      byStatus: await paymentLinkStatusCounts(tx, ctx.accountId),
    }));
    return NextResponse.json({ stats, by_status: byStatus }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
