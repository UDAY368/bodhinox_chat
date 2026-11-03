import { NextResponse } from 'next/server';
import { toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { getT } from '@/lib/i18n/translate';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { PaymentLinkError, sendPaymentLinkMessage, type PaymentLinkView } from './links';

/** What happened to "send this link into the conversation". */
export type SendResult =
  | { status: 'sent'; message_id: string | null }
  /** Refused before anything was sent (closed window, blocked contact…). */
  | { status: 'refused'; code: string; error: string }
  /** Meta refused it: nothing was delivered. */
  | { status: 'rejected'; error: string }
  /** The outcome is unknown; it is not sent again automatically. */
  | { status: 'uncertain'; error: string };

/** PaymentLinkError → its status and code; anything else → the generic account error response. */
export function linkErrorResponse(error: unknown): NextResponse {
  if (error instanceof PaymentLinkError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

/** A coded payments service error (refunds, offline payments, exceptions, links) → its status and code. */
export function paymentsErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && 'code' in error && 'status' in error && typeof error.status === 'number'
    && ['RefundError', 'OfflinePaymentError', 'ExceptionError', 'PaymentLinkError'].includes(error.name))
    return NextResponse.json({ error: error.message, code: (error as { code: string }).code }, { status: error.status });
  return toErrorResponse(error);
}

/** The JSON object body of a request, or null for anything else. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > 8 * 1024) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Sends a created link into its conversation and reports how it went; never throws for a send outcome. */
export async function sendLinkInto(ctx: AccountContext, link: PaymentLinkView, message: string | undefined, intentKey: string): Promise<SendResult> {
  const t = getT('Validation.payments');
  try {
    const sent = await sendPaymentLinkMessage({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role, linkId: link.id, message, intentKey });
    return { status: 'sent', message_id: sent.messageId };
  } catch (error) {
    if (error instanceof PaymentLinkError) return { status: 'refused', code: error.code, error: error.message };
    if (error instanceof UncertainDispatchError) return { status: 'uncertain', error: t('sendUncertain') };
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) return { status: 'rejected', error: t('sendRejected') };
    // Anything else after the intent was claimed is not known to have failed.
    return { status: 'uncertain', error: t('sendUncertain') };
  }
}
