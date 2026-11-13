// GET /api/payments/links/stats — totals for the Payments summary cards (agent and above): per currency, the count and
//   amount of paid links, links still waiting to be paid, and links that closed unpaid (expired, cancelled, failed).
//   200 { stats: PaymentLinkStatsRow[] }.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { paymentLinkStats } from '@/lib/payments/links';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const stats = await withTenant(tenantOf(ctx), (tx) => paymentLinkStats(tx, ctx.accountId));
    return NextResponse.json({ stats }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
