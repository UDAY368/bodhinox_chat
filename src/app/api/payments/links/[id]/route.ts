// GET  /api/payments/links/{id} — one payment link (agent and above).
// POST /api/payments/links/{id} — an action on it (agent and above):
//      { action: 'reconcile' }  settle with Razorpay: an 'unknown' link is looked up by
//                               reference before anything is created again; a live one
//                               is re-read, which may show it paid.
//      { action: 'cancel' }     cancel an unpaid link at Razorpay.
//      { action: 'send', message?, client_request_id }
//                               send it (again) into its conversation; one send per id.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { linkErrorResponse, sendLinkInto } from '@/lib/payments/http';
import { cancelPaymentLinkRecord, getPaymentLink, MESSAGE_MAX, reconcilePaymentLink } from '@/lib/payments/links';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Each action reaches Razorpay or Meta. */
const ACTION_LIMIT = { limit: 30, windowMs: 60_000 };

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const link = UUID.test(id) ? await withTenant(tenantOf(ctx), (tx) => getPaymentLink(tx, ctx.accountId, id)) : null;
    if (!link) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });
    return NextResponse.json({ link }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const limit = checkRateLimit(`paymentLinkAction:${ctx.userId}`, ACTION_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    let input: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      input = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: t('invalidRequest') }, { status: 400 });
    }
    // The caller's own role must see the link; actions then run through the worker.
    const link = UUID.test(id) ? await withTenant(tenantOf(ctx), (tx) => getPaymentLink(tx, ctx.accountId, id)) : null;
    if (!link) return NextResponse.json({ error: t('not_found'), code: 'not_found' }, { status: 404 });

    switch (input.action) {
      case 'reconcile': {
        const result = await reconcilePaymentLink(ctx.accountId, link.id);
        return NextResponse.json({ link: result.link, changed: result.changed }, { headers });
      }
      case 'cancel':
        return NextResponse.json({ link: await cancelPaymentLinkRecord(ctx.accountId, link.id) }, { headers });
      case 'send': {
        const clientRequestId = typeof input.client_request_id === 'string' && UUID.test(input.client_request_id) ? input.client_request_id : null;
        if (!clientRequestId) return NextResponse.json({ error: t('invalidRequest'), code: 'client_request_id' }, { status: 400 });
        const message = typeof input.message === 'string' ? input.message : undefined;
        if (message !== undefined && message.length > MESSAGE_MAX) return NextResponse.json({ error: t('invalid_message'), code: 'invalid_message' }, { status: 400 });
        const send = await sendLinkInto(ctx, link, message, `payment-link:${link.id}:send:${clientRequestId}`);
        return NextResponse.json({ link, send }, { status: send.status === 'sent' ? 200 : send.status === 'refused' ? 409 : 502, headers });
      }
      default:
        return NextResponse.json({ error: t('invalidRequest'), code: 'action' }, { status: 400 });
    }
  } catch (error) {
    return linkErrorResponse(error);
  }
}
