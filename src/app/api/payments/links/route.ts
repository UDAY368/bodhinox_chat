// GET  /api/payments/links — payment links, newest first (agent and above).
//      ?status=&conversation_id=&order_id=&contact_id=&before=<ISO>&limit=&q=<description or customer name>
// POST /api/payments/links — create a Razorpay link (agent and above).
//      { amount (major units, e.g. "499.50") | amount_minor, currency, description?,
//        conversation_id? | contact_id? | order_id?, expire_minutes?,
//        send?: true, message?, client_request_id }
//      `client_request_id` (a UUID per click) is the idempotency key: the same id
//      returns the link already created, never a second one. With `send`, the
//      link is then sent into the conversation from its own number.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { MoneyError, parseMoney } from '@/lib/commerce/money';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import {
  createPaymentLinkRecord,
  DESCRIPTION_MAX,
  listPaymentLinks,
  MAX_EXPIRE_MINUTES,
  MESSAGE_MAX,
  MIN_EXPIRE_MINUTES,
  PAYMENT_LINK_STATUSES,
  requestPaymentReference,
  validateCreateInput,
  type PaymentLinkStatus,
} from '@/lib/payments/links';
import { linkErrorResponse, sendLinkInto, type SendResult } from '@/lib/payments/http';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const t = getT('Validation.payments');
const headers = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Per agent: each link is a real Razorpay object. */
const CREATE_LIMIT = { limit: 20, windowMs: 60_000 };
/** Per workspace, so many agents together cannot flood Razorpay. */
const ACCOUNT_CREATE_LIMIT = { limit: 300, windowMs: 60 * 60_000 };

/** undefined when absent, null when present but not a UUID. */
const optionalId = (value: unknown): string | null | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' && UUID.test(value) ? value : null;
};

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const params = new URL(request.url).searchParams;
    const status = params.get('status');
    const ids = { conversationId: params.get('conversation_id'), orderId: params.get('order_id'), contactId: params.get('contact_id') };
    if (status && !(PAYMENT_LINK_STATUSES as readonly string[]).includes(status)) return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    if (Object.values(ids).some((id) => id && !UUID.test(id))) return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    const beforeRaw = params.get('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    const limit = Number(params.get('limit') ?? 50);
    const q = params.get('q')?.trim().slice(0, 100) || undefined;
    const links = await withTenant(tenantOf(ctx), (tx) => listPaymentLinks(tx, ctx.accountId, {
      q,
      status: (status as PaymentLinkStatus) || undefined,
      conversationId: ids.conversationId || undefined,
      orderId: ids.orderId || undefined,
      contactId: ids.contactId || undefined,
      before,
      limit: Number.isFinite(limit) ? limit : 50,
    }));
    return NextResponse.json({ links }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const userLimit = checkRateLimit(`paymentLink:${ctx.userId}`, CREATE_LIMIT);
    if (!userLimit.success) return rateLimitResponse(userLimit);

    let input: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      input = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: t('invalidRequest') }, { status: 400 });
    }
    const clientRequestId = typeof input.client_request_id === 'string' && UUID.test(input.client_request_id) ? input.client_request_id : null;
    if (!clientRequestId) return NextResponse.json({ error: t('invalidRequest'), code: 'client_request_id' }, { status: 400 });
    const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
    let amountMinor: number;
    try {
      if (input.amount_minor !== undefined) {
        amountMinor = typeof input.amount_minor === 'number' ? input.amount_minor : NaN;
      } else if (typeof input.amount === 'string' || typeof input.amount === 'number') {
        amountMinor = parseMoney(input.amount, currency);
      } else {
        amountMinor = NaN;
      }
    } catch (error) {
      if (error instanceof MoneyError) return NextResponse.json({ error: t('invalid_amount'), code: 'invalid_amount' }, { status: 400 });
      throw error;
    }
    const description = input.description === undefined || input.description === null || input.description === '' ? null : input.description;
    if (description !== null && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) {
      return NextResponse.json({ error: t('invalid_description'), code: 'invalid_description' }, { status: 400 });
    }
    let expireBy: Date | null = null;
    if (input.expire_minutes !== undefined && input.expire_minutes !== null) {
      const minutes = input.expire_minutes;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_EXPIRE_MINUTES || minutes > MAX_EXPIRE_MINUTES) {
        return NextResponse.json({ error: t('invalid_expiry'), code: 'invalid_expiry' }, { status: 400 });
      }
      expireBy = new Date(Date.now() + minutes * 60_000);
    }
    const conversationId = optionalId(input.conversation_id);
    const contactId = optionalId(input.contact_id);
    const orderId = optionalId(input.order_id);
    if (conversationId === null || contactId === null || orderId === null) return NextResponse.json({ error: t('target_not_found'), code: 'target_not_found' }, { status: 404 });
    const send = input.send === true;
    const message = typeof input.message === 'string' ? input.message : undefined;
    if (send && !conversationId) return NextResponse.json({ error: t('conversation_not_found'), code: 'conversation_not_found' }, { status: 400 });
    if (message !== undefined && message.length > MESSAGE_MAX) return NextResponse.json({ error: t('invalid_message'), code: 'invalid_message' }, { status: 400 });

    // Bad input is refused here, before the workspace limit is spent or Razorpay is called.
    validateCreateInput({ amountMinor, currency, description: description as string | null, expireBy });

    const accountLimit = checkRateLimit(`paymentLinkAccount:${ctx.accountId}`, ACCOUNT_CREATE_LIMIT);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const created = await createPaymentLinkRecord({
      accountId: ctx.accountId,
      actor: { kind: 'agent', userId: ctx.userId, role: ctx.role },
      amountMinor,
      currency,
      description: description as string | null,
      conversationId: conversationId ?? null,
      contactId: contactId ?? null,
      orderId: orderId ?? null,
      expireBy,
      referenceId: requestPaymentReference(ctx.accountId, ctx.userId, clientRequestId),
    });
    if (created.outcome === 'rejected') {
      const code = created.reason === 'auth' ? 'provider_auth' : 'provider_rejected';
      return NextResponse.json({ error: t(code), code, link: created.link }, { status: 502 });
    }
    let sendResult: SendResult | null = null;
    if (send && (created.link.status === 'created' || created.link.status === 'partially_paid')) {
      // Same request id, same intent: a retried click never sends twice.
      sendResult = await sendLinkInto(ctx, created.link, message, `payment-link:${created.link.id}:send:${clientRequestId}`);
    }
    return NextResponse.json(
      { link: created.link, outcome: created.outcome, send: sendResult },
      { status: created.outcome === 'existing' ? 200 : 201, headers },
    );
  } catch (error) {
    return linkErrorResponse(error);
  }
}
