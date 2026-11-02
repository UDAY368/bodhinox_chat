// GET  /api/billing/subscription — any member: whether billing is configured and
//      the workspace's subscription; admins also see provider calls still being confirmed.
// POST /api/billing/subscription — admins with the 'settings.billing' permission:
//      { action: 'cancel' }                          at the end of the paid period (now when payment is failing)
//      { action: 'change_plan', plan, interval }     upgrade now (prorated) or downgrade at period end
//      { action: 'resume' }                          the provider's page to pay a failing subscription
//   200 { state: 'done' | 'scheduled' } or { state: 'pay', short_url }; 202 { state: 'pending' } when the
//   provider's answer was lost (reconciled by the billing sweep, never retried).

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { can, requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { badRequest, billingErrorResponse, jsonBody, NO_STORE } from '@/lib/billing/http';
import { billingConfigured } from '@/lib/billing/razorpay-billing';
import { getBillingOverview, paymentLink, requestCancel, requestPlanChange, type ChangeResult } from '@/lib/billing/subscriptions';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const admin = hasMinRole(ctx.role, 'admin');
    const { canManage, overview } = await withTenant(tenantOf(ctx), async (tx) => ({
      // Admins whose role has not been restricted from billing manage it.
      canManage: admin && (await can(tx, { accountId: ctx.accountId, role: ctx.role }, 'settings.billing')),
      overview: await getBillingOverview(tx, ctx.accountId, admin),
    }));
    return NextResponse.json({ configured: billingConfigured(), can_manage: canManage, ...overview }, { headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(error);
  }
}

const reply = (result: ChangeResult) =>
  NextResponse.json({ state: result.state }, { status: result.state === 'pending' ? 202 : 200, headers: NO_STORE });

export async function POST(request: Request) {
  try {
    await assertMutation(request, await requireSession(request));
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'settings.billing');
    const limit = checkRateLimit(`billingSubscription:${ctx.accountId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await jsonBody(request);
    const scope = { accountId: ctx.accountId, userId: ctx.userId };
    switch (body?.action) {
      case 'cancel':
        return reply(await requestCancel(scope));
      case 'change_plan': {
        const { plan, interval } = body;
        if (typeof plan !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(plan) || (interval !== 'month' && interval !== 'year')) return badRequest('invalid_request');
        return reply(await requestPlanChange({ ...scope, plan, interval }));
      }
      case 'resume': {
        const { shortUrl } = await paymentLink(ctx.accountId);
        return NextResponse.json({ state: 'pay', short_url: shortUrl }, { headers: NO_STORE });
      }
      default:
        return badRequest('invalid_request');
    }
  } catch (error) {
    return billingErrorResponse(error);
  }
}
