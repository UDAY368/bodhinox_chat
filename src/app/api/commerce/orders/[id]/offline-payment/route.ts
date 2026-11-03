// POST /api/commerce/orders/{id}/offline-payment — record a payment taken
// outside the gateway (cash, bank transfer…) for exactly the amount still due.
// Admin and above with the commerce.record_payments permission; audited and
// shown as staff-recorded. Any live payment link for the order is cancelled
// first. This is the only staff path to "paid" (design E10).
//     { amount (major units), method, reference?, client_request_id }

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import { paymentsErrorResponse, readJsonObject } from '@/lib/payments/http';
import { OFFLINE_METHODS, recordOfflinePayment, REFERENCE_MAX, type OfflineMethod } from '@/lib/payments/offline';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT = { limit: 20, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    const limit = checkRateLimit(`offlinePayment:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const body = await readJsonObject(request);
    if (!body) return NextResponse.json({ error: t('invalidRequest') }, { status: 400 });
    const clientRequestId = typeof body.client_request_id === 'string' && UUID.test(body.client_request_id) ? body.client_request_id : null;
    if (!clientRequestId) return NextResponse.json({ error: t('invalidRequest'), code: 'client_request_id' }, { status: 400 });
    if (!UUID.test(id)) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    if (typeof body.amount !== 'string' || body.amount.length > 32) return NextResponse.json({ error: t('invalidRequest'), code: 'amount' }, { status: 400 });
    if (!(OFFLINE_METHODS as readonly unknown[]).includes(body.method)) return NextResponse.json({ error: t('invalidRequest'), code: 'method' }, { status: 400 });
    const reference = body.reference === undefined || body.reference === null ? null : body.reference;
    if (reference !== null && (typeof reference !== 'string' || reference.length > REFERENCE_MAX))
      return NextResponse.json({ error: t('invalidRequest'), code: 'reference' }, { status: 400 });
    const { paymentId } = await recordOfflinePayment({ ...tenantOf(ctx), userId: ctx.userId }, id, {
      amount: body.amount, method: body.method as OfflineMethod, reference, clientRequestId,
    });
    return NextResponse.json({ payment_id: paymentId }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return paymentsErrorResponse(error);
  }
}
