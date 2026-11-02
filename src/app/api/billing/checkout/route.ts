// POST /api/billing/checkout — admins (with the 'settings.billing' permission) start a subscription. Body { plan, interval: 'month'|'year' }.
// Requires a billing profile. Creates (or reuses) the provider customer and a
// subscription, and returns what Razorpay Checkout needs:
//   200 { state: 'ready', subscription_id, short_url, key_id, prefill: { name, email } }
//   202 { state: 'pending' }  the provider's answer was lost; it is reconciled, try again shortly
// Idempotent per workspace and plan: an unpaid checkout for the same plan is
// returned again. Nothing changes the plan until the provider's webhook
// confirms the authorisation. key_id is Razorpay's public key; no secret leaves the server.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { badRequest, billingErrorResponse, jsonBody, NO_STORE } from '@/lib/billing/http';
import { startCheckout } from '@/lib/billing/subscriptions';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    await assertMutation(request, await requireSession(request));
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'settings.billing');
    const limit = checkRateLimit(`billingCheckout:${ctx.accountId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await jsonBody(request);
    const plan = body?.plan, interval = body?.interval;
    if (typeof plan !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(plan) || (interval !== 'month' && interval !== 'year')) return badRequest('invalid_request');
    const result = await startCheckout({ accountId: ctx.accountId, userId: ctx.userId, plan, interval });
    if (result.state === 'pending') return NextResponse.json({ state: 'pending' }, { status: 202, headers: NO_STORE });
    return NextResponse.json({
      state: 'ready',
      subscription_id: result.subscriptionId,
      short_url: result.shortUrl,
      key_id: result.keyId,
      prefill: result.prefill,
    }, { headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(error);
  }
}
