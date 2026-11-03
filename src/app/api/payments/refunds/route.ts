// GET /api/payments/refunds — refunds (ours and Razorpay dashboard refunds), newest first. Agent and above.
//     ?order_id=&payment_id=&status=&before=<ISO>&limit=

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { listCustomerRefunds } from '@/lib/payments/queries';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ['requested', 'sending', 'pending', 'processed', 'failed', 'unknown'];

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const params = new URL(request.url).searchParams;
    const orderId = params.get('order_id') || undefined;
    const paymentId = params.get('payment_id') || undefined;
    const status = params.get('status') || undefined;
    const beforeRaw = params.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if ((orderId && !UUID.test(orderId)) || (paymentId && !UUID.test(paymentId)) || (status && !STATUSES.includes(status))
      || (before && Number.isNaN(before.getTime()))) return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    const limit = Number(params.get('limit') ?? 50);
    const refunds = await withTenant(tenantOf(ctx), (tx) => listCustomerRefunds(tx, ctx.accountId, {
      orderId, paymentId, status, before, limit: Number.isFinite(limit) ? limit : 50,
    }));
    return NextResponse.json({ refunds }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}
