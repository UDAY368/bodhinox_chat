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
