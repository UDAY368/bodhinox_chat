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
 * Send the order's payment link to the customer. An open link is reused (sent again) instead of making a
 * second one; otherwise a new link for what is still due is made and sent into the order's chat. Without a
 * chat the link is only copied. Throws with the server's message when no link can be made.
 */
export async function sendOrderPaymentLink(order: LinkableOrder, description: string, fallback: string): Promise<LinkOutcome> {
  const open = (await listPaymentLinks({ orderId: order.id }, fallback)).find((l) => LIVE_LINK.has(l.status));
  if (open) {
    await copy(open.short_url);
    if (!open.conversation_id) return { kind: "copied", link: open };
    return sendOutcome(await sendPaymentLink(open.id, crypto.randomUUID(), fallback), open, true);
  }
  const due = (order.total_minor ?? order.subtotal_minor) - order.amount_paid_minor;
  const { link, send } = await createPaymentLinkWithSend({
    amount: minorToDecimalString(due, order.currency), currency: order.currency, description: description.slice(0, 200), order_id: order.id,
    ...(order.conversation_id ? { conversation_id: order.conversation_id, send: true } : {}),
    client_request_id: crypto.randomUUID(),
  }, fallback);
  await copy(link.short_url);
  if (!order.conversation_id) return { kind: "copied", link };
  return sendOutcome(send, link, false);
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
