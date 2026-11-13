"use client";

// Customer-facing order actions from Sales → Orders (row menu, drawer, New order):
// sending the order's payment link and sending a status update. Both go
// through the existing durable send paths (payment links: dispatchOnce per
// request id, the 24-hour window and blocked-contact checks; the inbox send
// route: the same window rule, templates outside it). Nothing here retries a
// send on its own: an uncertain outcome is reported, never re-sent.

import { authFetch } from "@/lib/auth/client";
import { minorToDecimalString } from "@/lib/commerce/money";
import {
  createPaymentLinkWithSend, listPaymentLinks, LIVE_LINK, sendPaymentLink, type LinkSendResult, type PaymentLinkItem,
} from "@/components/commerce/payments/payment-api";

export interface LinkableOrder {
  id: string;
  currency: string;
  total_minor: number | null;
  subtotal_minor: number;
  amount_paid_minor: number;
  conversation_id: string | null;
  contact: { id: string } | null;
}

export type LinkOutcome =
  | { kind: "sent"; reused: boolean; link: PaymentLinkItem }
  | { kind: "copied"; link: PaymentLinkItem }
  | { kind: "not_sent"; link: PaymentLinkItem; reason: string };

async function copy(url: string | null): Promise<boolean> {
  if (!url) return false;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

const sendOutcome = (send: LinkSendResult | null, link: PaymentLinkItem, reused: boolean): LinkOutcome =>
  send?.status === "sent" ? { kind: "sent", reused, link } : { kind: "not_sent", link, reason: send && "error" in send ? send.error : "" };

/**
 * One "Send payment link" attempt per order: its idempotency key (the create's client_request_id, or the
 * re-send's request id for an open link) and, for a re-send, the link it targets. The attempt is kept until
 * its outcome is definite, so a retry after a timeout or a server error repeats the same request (the server
 * answers with the same link and dispatchOnce does not send it twice) instead of making a second link.
 */
interface LinkAttempt { key: string; linkId: string | null }
const attempts = new Map<string, LinkAttempt>();

/** Forget the order's pending attempt so the next click starts a new one (test hook and explicit new attempt). */
export function clearPaymentLinkAttempt(orderId?: string): void {
  if (orderId === undefined) attempts.clear();
  else attempts.delete(orderId);
}

/** The pending attempt's key for an order, if any (for tests and UI hints). */
export function pendingPaymentLinkAttempt(orderId: string): string | null {
  return attempts.get(orderId)?.key ?? null;
}

/**
 * A send outcome that cannot change on a retry: sent, or refused/rejected by the server. "uncertain" is kept,
 * and so is a response without a send result (code "error": a server error the client cannot classify).
 */
const definiteSend = (send: LinkSendResult | null) =>
  send === null || (send.status !== "uncertain" && !(send.status === "refused" && send.code === "error"));

/** A thrown create that made nothing for sure: a 4xx refusal (not rate limiting) or a provider rejection. */
function definiteFailure(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  if (e?.code === "provider_rejected" || e?.code === "provider_auth") return true;
  const status = e?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/**
 * Send the order's payment link to the customer. An open link is reused (sent again) instead of making a
 * second one; otherwise a new link for what is still due is made and sent into the order's chat. Without a
 * chat the link is only copied. Throws with the server's message when no link can be made. A retry of an
 * attempt whose outcome was not definite reuses that attempt's idempotency key.
 */
export async function sendOrderPaymentLink(order: LinkableOrder, description: string, fallback: string): Promise<LinkOutcome> {
  let attempt = attempts.get(order.id);
  if (!attempt) {
    const open = (await listPaymentLinks({ orderId: order.id }, fallback)).find((l) => LIVE_LINK.has(l.status));
    attempt = { key: crypto.randomUUID(), linkId: open?.id ?? null };
    attempts.set(order.id, attempt);
    if (open) {
      await copy(open.short_url);
      if (!open.conversation_id) {
        attempts.delete(order.id);
        return { kind: "copied", link: open };
      }
      return resend(order.id, attempt, open, fallback);
    }
  } else if (attempt.linkId) {
    const link = (await listPaymentLinks({ orderId: order.id }, fallback)).find((l) => l.id === attempt!.linkId);
    if (link && LIVE_LINK.has(link.status) && link.conversation_id) return resend(order.id, attempt, link, fallback);
    // The link the attempt targeted is gone or closed: start over with a new attempt.
    attempts.delete(order.id);
    return sendOrderPaymentLink(order, description, fallback);
  }
  const due = (order.total_minor ?? order.subtotal_minor) - order.amount_paid_minor;
  let created: { link: PaymentLinkItem; send: LinkSendResult | null };
  try {
    created = await createPaymentLinkWithSend({
      amount: minorToDecimalString(due, order.currency), currency: order.currency, description: description.slice(0, 200), order_id: order.id,
      ...(order.conversation_id ? { conversation_id: order.conversation_id, send: true } : {}),
      client_request_id: attempt.key,
    }, fallback);
  } catch (err) {
    if (definiteFailure(err)) attempts.delete(order.id);
    throw err;
  }
  const { link, send } = created;
  await copy(link.short_url);
  if (!order.conversation_id) {
    attempts.delete(order.id);
    return { kind: "copied", link };
  }
  if (definiteSend(send)) attempts.delete(order.id);
  return sendOutcome(send, link, false);
}

async function resend(orderId: string, attempt: LinkAttempt, link: PaymentLinkItem, fallback: string): Promise<LinkOutcome> {
  const send = await sendPaymentLink(link.id, attempt.key, fallback);
  if (definiteSend(send)) attempts.delete(orderId);
  return sendOutcome(send, link, true);
}

/** Send a text into the order's chat through the inbox send route. Returns null when sent, else the server's reason. */
export async function sendOrderUpdate(conversationId: string, text: string): Promise<string | null> {
  const res = await authFetch("/api/whatsapp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: conversationId, message_type: "text", content_text: text }),
  });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" && body.error ? body.error : `HTTP ${res.status}`;
}
