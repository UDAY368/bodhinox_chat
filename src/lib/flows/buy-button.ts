// Stage 5 (5G): buy buttons on Instagram cards. 5B calls buyButtonUrl for each
// `buy` button when it sends a card; the URL becomes an ordinary web-URL button.
//
// There is no in-DM payment on Instagram: a buy button always opens a checkout
// page. The link is made through the existing payment-link code
// (createPaymentLinkRecord, actor 'bot'), carrying the run id and step so
// revenue can be attributed to the flow (5F), and keyed by run, step and
// button slot: a retried send finds the same link instead of creating a
// second one. The flow does not wait for the payment (a buy link never resumes
// the run: resumePaymentLinkRun only resumes payment_link steps). Null when no
// usable link exists (no payment provider, invalid amount, an earlier create
// with an unknown outcome): the engine then drops the button and logs an event.
// Nothing about the customer or the link URL is logged.

import { createHash } from 'node:crypto';
import { isCurrencyCode } from '@/lib/commerce/money';
import { createPaymentLinkRecord, PaymentLinkError } from '@/lib/payments/links';
import type { FlowRunRow, IgCardButton } from './types';

export type BuyButton = Extract<IgCardButton, { type: 'buy' }>;

export const BUY_BUTTON_LIMITS = {
  title: 20,
  /** Same ceiling as the payment links (minor units). */
  maxMinor: 100_000_000_00,
  /** A buy link stays open for 7 days. */
  expireDays: 7,
} as const;

/** A slot names the button inside the step, e.g. `card:0:button:1`. */
const SLOT = /^[a-z0-9_:-]{1,64}$/i;

/** The payment-link reference of one buy button: one per run, step and slot. */
export function buyButtonReference(runId: string, nodeKey: string, slot: string): string {
  const digest = createHash('sha256').update(`buy:${runId}:${nodeKey}:${slot}`).digest('base64url').slice(0, 32);
  return `fl_${digest}`;
}

/** The slot key of a button inside a card or gallery step. */
export function buyButtonSlot(cardIndex: number, buttonIndex: number): string {
  return `card:${cardIndex}:button:${buttonIndex}`;
}

/** What is wrong with a buy button's own fields, or null (for the validator and the form). */
export function buyButtonProblem(button: unknown): 'title' | 'amount' | 'currency' | null {
  const b = button as Partial<BuyButton> | null;
  if (!b || typeof b !== 'object') return 'title';
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > BUY_BUTTON_LIMITS.title) return 'title';
  if (typeof b.currency !== 'string' || !isCurrencyCode(b.currency)) return 'currency';
  if (typeof b.amount_minor !== 'number' || !Number.isSafeInteger(b.amount_minor) || b.amount_minor <= 0
    || b.amount_minor > BUY_BUTTON_LIMITS.maxMinor) return 'amount';
  return null;
}

/** The checkout URL for a buy button, or null (the button is dropped). Never throws. */
export async function buyButtonUrl(run: Pick<FlowRunRow, 'id' | 'account_id' | 'contact_id' | 'conversation_id'>,
  nodeKey: string, slot: string, button: BuyButton): Promise<string | null> {
  if (!run.contact_id || !run.conversation_id || !nodeKey || !SLOT.test(slot) || buyButtonProblem(button)) return null;
  try {
    const { link } = await createPaymentLinkRecord({
      accountId: run.account_id,
      actor: { kind: 'bot' },
      amountMinor: button.amount_minor,
      currency: button.currency,
      description: button.title.trim(),
      contactId: run.contact_id,
      conversationId: run.conversation_id,
      flowRunId: run.id,
      nodeKey,
      expireBy: new Date(Date.now() + BUY_BUTTON_LIMITS.expireDays * 24 * 60 * 60_000),
      referenceId: buyButtonReference(run.id, nodeKey, slot),
    });
    // Only a link the customer can pay: never a failed, expired or unknown one.
    if (!link.short_url || !/^https:\/\//.test(link.short_url)) return null;
    return link.status === 'created' || link.status === 'partially_paid' ? link.short_url : null;
  } catch (error) {
    console.info('[flow buy button] no link', { reason: error instanceof PaymentLinkError ? error.code : 'failed' });
    return null;
  }
}
