// POST /api/payments/refunds/{id} — an action on one refund. Admin and above
// with the commerce.refunds permission.
//     { action: 'reconcile' }  read Razorpay's refunds for its payment and apply
//                              them; an unknown refund Razorpay does not hold
//                              becomes failed ('absent'). Never sends.
//     { action: 'retry' }      a failed refund (refused, or proven absent) is
//                              sent again as a new attempt.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { requirePermission } from '@/lib/auth/permissions';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { paymentsErrorResponse, readJsonObject } from '@/lib/payments/http';
import { reconcileRefund, retryRefund } from '@/lib/payments/refunds';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Each action reaches Razorpay. */
const LIMIT = { limit: 30, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    const limit = checkRateLimit(`refundAction:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readJsonObject(request);
    if (!body) return NextResponse.json({ error: t('invalidRequest') }, { status: 400 });
    if (!UUID.test(id)) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    const tenant = { ...tenantOf(ctx), userId: ctx.userId };
    // The caller's own role must see the refund.
    const seen = await withTenant(tenantOf(ctx), (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`);
    if (!seen[0]) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    switch (body.action) {
      case 'reconcile': {
        await requirePermission(tenant, 'commerce.refunds');
        const result = await reconcileRefund(ctx.accountId, id);
        return NextResponse.json({ result }, { headers });
      }
      case 'retry': {
        const { attempt } = await retryRefund(tenant, id);
        return NextResponse.json({ attempt }, { status: 202, headers });
      }
      default:
        return NextResponse.json({ error: t('invalidRequest'), code: 'action' }, { status: 400 });
    }
  } catch (error) {
    return paymentsErrorResponse(error);
  }
}
