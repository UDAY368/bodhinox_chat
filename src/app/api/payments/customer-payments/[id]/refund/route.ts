// POST /api/payments/customer-payments/{id}/refund — refund part or all of a
// gateway payment. Admin and above with the commerce.refunds permission.
//     { amount (major units, e.g. "120.50"), reason, note?, restock?, return_id?, client_request_id }
// The refund row, its send job and the audit entry commit together; the send
// happens in the worker. `client_request_id` (a UUID per click) makes a replay
// return the same refund instead of refunding twice.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { paymentsErrorResponse, readJsonObject } from '@/lib/payments/http';
import { refundAmountFrom, REFUND_REASONS, requestRefund, type RefundReason } from '@/lib/payments/refunds';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = { limit: 20, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    const limit = checkRateLimit(`paymentRefund:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readJsonObject(request);
    if (!body) return NextResponse.json({ error: t('invalidRequest') }, { status: 400 });
    const clientRequestId = typeof body.client_request_id === 'string' && UUID.test(body.client_request_id) ? body.client_request_id : null;
    if (!clientRequestId) return NextResponse.json({ error: t('invalidRequest'), code: 'client_request_id' }, { status: 400 });
    if (!UUID.test(id)) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    if (!(REFUND_REASONS as readonly unknown[]).includes(body.reason)) return NextResponse.json({ error: t('invalidRequest'), code: 'reason' }, { status: 400 });
    if (typeof body.amount !== 'string' && typeof body.amount !== 'number') return NextResponse.json({ error: t('invalidRequest'), code: 'amount' }, { status: 400 });
    // The caller's own role must see the payment; its currency decides how the amount is read.
    const payment = (await withTenant(tenantOf(ctx), (tx) =>
      tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM customer_payments WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`))[0];
    if (!payment) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    const amountMinor = refundAmountFrom(body.amount, payment.currency);
    const returnId = typeof body.return_id === 'string' && body.return_id ? body.return_id : null;
    const { refundId } = await requestRefund({ ...tenantOf(ctx), userId: ctx.userId }, {
      paymentId: id, amountMinor, reason: body.reason as RefundReason, note: typeof body.note === 'string' ? body.note : null,
      restock: body.restock === true, returnId, clientRequestId,
    });
    return NextResponse.json({ refund_id: refundId }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return paymentsErrorResponse(error);
  }
}
