// POST /api/whatsapp/send-product — send a catalogue message into an open conversation (agent, rate limited).
//   { conversation_id, kind: 'product', product_id, body?, footer?, client_request_id? }
//   { conversation_id, kind: 'product_list', header, body, footer?, sections: [{ title, product_ids: [] }], client_request_id? }
//   { conversation_id, kind: 'catalog', body, footer?, thumbnail_product_id?, client_request_id? }
// Product ids are products.id of the catalogue linked to the conversation's number; it sends from that number.
//   200 { success, message_id, whatsapp_message_id }
//   400/404/409 { error, code } refusal (nothing sent); 409 { error } without code: the outcome is
//   unknown and is never re-sent; 502 Meta rejected it. The same client_request_id never sends twice.

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { CommerceSendError, commerceMessageFromRequest, commerceRejectionKey, sendCommerceMessage } from '@/lib/commerce/catalog-send';
import { getT } from '@/lib/i18n/translate';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = getT('Validation.commerceSend');

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export async function POST(request: Request) {
  try {
    // Agents and above send, as in /api/whatsapp/send: Meta is called before anything is stored.
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`send:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const raw = await request.json().catch(() => null);
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const conversationId = text(body.conversation_id) ?? '';
    const message = commerceMessageFromRequest(body);
    if (!UUID.test(conversationId) || !message) {
      return NextResponse.json({ error: t('invalid_message'), code: 'invalid_message' }, { status: 400 });
    }
    const requestId = typeof body.client_request_id === 'string' && UUID.test(body.client_request_id) ? body.client_request_id : randomUUID();
    try {
      const result = await sendCommerceMessage({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        sender: 'agent',
        conversationId,
        message,
        intentKey: `commerce:inbox:${conversationId}:${requestId}`,
      });
      return NextResponse.json({ success: true, message_id: result.messageId, whatsapp_message_id: result.whatsappMessageId });
    } catch (err) {
      if (err instanceof CommerceSendError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
      if (err instanceof UncertainDispatchError) return NextResponse.json({ error: t('uncertain') }, { status: 409 });
      if (err instanceof MetaApiError) {
        // Meta's numbers only (never its text or the message content).
        console.warn('[send-product] WhatsApp rejected', err.httpStatus, err.code, err.subcode);
        const reason = t(commerceRejectionKey(err));
        return NextResponse.json({ error: err.code ? `${reason} (${t('metaCode', { code: err.code })})` : reason, meta_code: err.code },
          { status: 502 });
      }
      throw err;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
