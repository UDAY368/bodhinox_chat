/**
 * Store plan Phase 3, package 4: the jobs and the inbound replies behind product
 * reviews (rules and queueing are in reviews.ts).
 *
 * Request (commerce.review_request, three days after delivery): same pipeline as the
 * COD confirmation. Every refusal is decided before dispatchOnce and recorded in the
 * order_messages ledger (kind review_request; reason list or template when sent), the
 * send goes through dispatchOnce('order:<id>:review_request'), and an uncertain outcome
 * is recorded for staff and never re-sent. It is marketing: a blocked or opted-out
 * contact, a suspended workspace and an agent's takeover of the chat all hold it back.
 * Inside the customer window it is a list of five star rows; outside it the workspace's
 * approved MARKETING template of notice kind review_request (none set -> blocked).
 *
 * Replies: a tap on a star row from the order's own contact stores the rating
 * (pending) and gets one thank-you; after a template request a plain 1 to 5 within
 * seven days does the same. The same contact's next plain message within 30 minutes
 * becomes the review text. Replays find their own work again through the message id
 * stored with the rating and the text. Logs carry ids and codes only.
 */
import { createAdminClient } from '@/lib/data/admin';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isSuspended } from '@/lib/billing/suspension';
import { engineSendInteractive, engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import type { InteractiveListPayload } from '@/lib/whatsapp/interactive';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { pickConversation, rejectedByProvider, windowOpen, type ContactRow } from './cart-followup-jobs';
import {
  agentHoldRefusal, consentRefusal, followupBodyValues, loadTemplate, noticeTemplate, NOTICE_TEMPLATE_CATEGORY, orderReference,
  orderTemplateOutcome, worker, type Outcome, type TemplateRow,
} from './order-followup';
import {
  cleanReviewBody, isShopCommand, isSkipText, parseRatingText, parseReviewReplyId, REVIEW_BODY_WINDOW_MS, REVIEW_TEXT_REPLY_DAYS,
  reviewerInitial, reviewReplyId,
} from './reviews';

export const reviewRequestIntentKey = (orderId: string) => `order:${orderId}:review_request`;
export const reviewAckIntentKey = (reviewId: string) => `review:${reviewId}:ack`;

/** The order's highest-value product line (price times quantity), or null when no line is a catalogue product. */
export async function reviewProductTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT p.id::text AS id, p.name FROM order_items i
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid
    ORDER BY i.unit_price_minor * i.quantity DESC, i.id LIMIT 1`;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The request

export interface ReviewRequestJobPayload { orderId: string }

/** The star-row list asked inside the customer window. Row ids carry the order, product and stars. */
export function reviewListPayload(orderId: string, productId: string, productName: string): InteractiveListPayload {
  const t = getT('OrderNotices');
  const product = Array.from(productName).slice(0, 100).join('');
  return {
    kind: 'list',
    body: t('reviewRequestBody', { product }),
    button_label: t('reviewRate'),
    sections: [{
      rows: [5, 4, 3, 2, 1].map((n) => ({ id: reviewReplyId(orderId, productId, n), title: '★'.repeat(n), description: t(`reviewLabel${n}`) })),
    }],
  };
}

type RequestPlan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | { kind: 'list'; contactId: string; conversationId: string; orderId: string; productId: string; productName: string }
  | { kind: 'template'; contactId: string; conversationId: string; template: TemplateRow; values: string[] };

async function settleRequest(accountId: string, orderId: string, outcome: Outcome) {
  await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO order_messages(account_id,order_id,kind,status,reason)
    VALUES(${accountId}::uuid,${orderId}::uuid,'review_request',${outcome.status},${outcome.reason})
    ON CONFLICT(account_id,order_id,kind) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_at=now()
    WHERE order_messages.resolved_at IS NULL`);
}

async function planRequest(accountId: string, orderId: string, now: Date): Promise<RequestPlan> {
  return worker(accountId, async (tx): Promise<RequestPlan> => {
    const [order] = await tx.$queryRaw<{ id: string; external_id: string | null; status: string; refund_state: string; contact_id: string | null;
      conversation_id: string | null; whatsapp_config_id: string | null }[]>`
      SELECT id::text AS id, external_id, status, refund_state, contact_id::text AS contact_id, conversation_id::text AS conversation_id,
        whatsapp_config_id::text AS whatsapp_config_id
      FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    if (!order) return { kind: 'done' };
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM order_messages WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='review_request'`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };
    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${reviewRequestIntentKey(orderId)}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return { kind: 'settle', outcome: { status: 'failed', reason: 'provider_rejected' } };
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    const skip = (reason: string): RequestPlan => ({ kind: 'settle', outcome: { status: 'skipped', reason } });
    const block = (reason: string): RequestPlan => ({ kind: 'settle', outcome: { status: 'blocked', reason } });
    const fail = (reason: string): RequestPlan => ({ kind: 'settle', outcome: { status: 'failed', reason } });
    if (order.status !== 'fulfilled') return skip('stale_status');
    if (order.refund_state === 'full') return skip('refunded');
    const [settings] = await tx.$queryRaw<{ enabled: boolean }[]>`
      SELECT review_requests_enabled AS enabled FROM commerce_settings WHERE account_id=${accountId}::uuid`;
    if (!settings?.enabled) return skip('disabled');
    if (!order.contact_id) return skip('contact_missing');
    const product = await reviewProductTx(tx, accountId, orderId);
    if (!product) return skip('no_product');
    const [reviewed] = await tx.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM shop_reviews WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND product_id=${product.id}::uuid`;
    if (reviewed) return skip('already_reviewed');
    const [contact] = await tx.$queryRaw<ContactRow[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${order.contact_id}::uuid`;
    if (!contact) return skip('contact_missing');
    // A marketing message: any opt-out (not only one after the purchase) and a block refuse it.
    const consent = consentRefusal(contact, new Date(0));
    if (consent) return skip(consent);
    if (await isSuspended(tx, accountId)) return block('workspace_suspended');
    if (!resolveContactSendTarget(contact)) return fail('no_address');
    const conversation = await pickConversation(tx, accountId, contact.id, order.conversation_id);
    if (!conversation) return fail('no_conversation');
    // Decided before any outbound intent: an agent's takeover of the chat holds a marketing message back.
    const held = agentHoldRefusal('review_request', conversation.bot_paused);
    if (held) return block(held);
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id ?? order.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return fail('number_unavailable');
      throw error;
    }
    if (isNumberDisconnected(config)) return fail('number_unavailable');
    if (windowOpen(conversation, now))
      return { kind: 'list', contactId: contact.id, conversationId: conversation.id, orderId, productId: product.id, productName: product.name };
    const setting = await noticeTemplate(tx, accountId, 'review_request');
    if (!setting) return block('no_template');
    const template = await loadTemplate(tx, accountId, setting.name, setting.language);
    const refusal = orderTemplateOutcome(template, config, NOTICE_TEMPLATE_CATEGORY.review_request);
    if (refusal || !template) return { kind: 'settle', outcome: refusal ?? { status: 'blocked', reason: 'template_not_found' } };
    // {{1}} customer name, {{2}} product, {{3}} order reference. The template can only ask the buyer to reply with 1 to 5.
    return { kind: 'template', contactId: contact.id, conversationId: conversation.id, template,
      values: [contact.name || '-', product.name, orderReference(order)] };
  });
}

/** Run one review request job. An uncertain send is recorded in the order_messages ledger and never repeated. */
export async function handleReviewRequestJob(
  accountId: string, payload: ReviewRequestJobPayload, meta: { attempts: number; maxAttempts: number }, now = new Date(),
): Promise<Outcome | null> {
  const { orderId } = payload;
  const uncertain = async () => {
    await settleRequest(accountId, orderId, { status: 'outcome_unknown', reason: 'uncertain' });
    if (meta.attempts < meta.maxAttempts) throw new UncertainDispatchError();
  };
  const p = await planRequest(accountId, orderId, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    if (p.uncertain) {
      await uncertain();
      return p.outcome;
    }
    await settleRequest(accountId, orderId, p.outcome);
    return p.outcome;
  }
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  // Marketing, so not a service message: the send path itself also honours an agent's takeover.
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId };
  try {
    if (p.kind === 'list') {
      await dispatchOnce(accountId, reviewRequestIntentKey(orderId), () =>
        engineSendInteractive({ ...base, payload: reviewListPayload(p.orderId, p.productId, p.productName) }));
    } else {
      const template = p.template;
      const body = followupBodyValues(template, p.values);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, reviewRequestIntentKey(orderId), () => engineSendTemplate({
        ...base, templateName: template.name, language: template.language ?? undefined, params: body, bodyValuesOnly: false,
        messageParams: { body, ...(headerVar ? { headerText: (p.values[1] ?? '-').slice(0, 60) } : {}) },
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await uncertain();
      return { status: 'outcome_unknown', reason: 'uncertain' };
    }
    if (rejectedByProvider(error)) {
      const outcome: Outcome = { status: 'failed', reason: 'provider_rejected' };
      await settleRequest(accountId, orderId, outcome);
      return outcome;
    }
    throw error;
  }
  const outcome: Outcome = { status: 'sent', reason: p.kind };
  await settleRequest(accountId, orderId, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// The buyer's replies

export interface ReviewReplyInput {
  accountId: string;
  /** The sender, as resolved by the inbound pipeline. */
  contactId: string;
  conversationId: string;
  /** The inbound message row; a retried job finds its own rating or text again through it. */
  messageId: string;
}

export interface ReviewReplyResult {
  /** True when the message was this feature's: flows, automations, AI and the away message then stay silent. */
  handled: boolean;
  outcome: 'rated' | 'body' | 'skipped' | 'ignored';
}

type Runner = (send: () => Promise<unknown>) => Promise<unknown>;
const direct: Runner = (send) => send();

/** Store the stars for an order's product when the sender is the order's own contact and it is delivered. */
async function recordRating(accountId: string, contactId: string, messageId: string, orderId: string, productId: string, rating: number,
  replay: boolean): Promise<string | null> {
  return worker(accountId, async (tx) => {
    const [owner] = await tx.$queryRaw<{ name: string | null }[]>`
      SELECT c.name FROM orders o JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
      WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid AND o.contact_id=${contactId}::uuid AND o.status='fulfilled'
        AND EXISTS (SELECT 1 FROM order_items i JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
          WHERE i.account_id=o.account_id AND i.order_id=o.id AND v.product_id=${productId}::uuid)`;
    if (!owner) return null;
    const initial = reviewerInitial(owner.name);
    // A tap may change a rating until an admin moderates it. A typed digit only ever creates the first rating (replay: same message).
    const [row] = replay
      ? await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO shop_reviews(account_id,product_id,order_id,contact_id,rating,reviewer_initial,rating_message_id)
          VALUES(${accountId}::uuid,${productId}::uuid,${orderId}::uuid,${contactId}::uuid,${rating},${initial},${messageId}::uuid)
          ON CONFLICT (account_id,order_id,product_id) DO UPDATE SET rating=shop_reviews.rating
            WHERE shop_reviews.rating_message_id=${messageId}::uuid
          RETURNING id::text AS id`
      : await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO shop_reviews(account_id,product_id,order_id,contact_id,rating,reviewer_initial,rating_message_id)
          VALUES(${accountId}::uuid,${productId}::uuid,${orderId}::uuid,${contactId}::uuid,${rating},${initial},${messageId}::uuid)
          ON CONFLICT (account_id,order_id,product_id) DO UPDATE SET
            rating=CASE WHEN shop_reviews.status='pending' THEN EXCLUDED.rating ELSE shop_reviews.rating END,
            rating_message_id=CASE WHEN shop_reviews.status='pending' THEN EXCLUDED.rating_message_id ELSE shop_reviews.rating_message_id END
          RETURNING id::text AS id`;
    return row?.id ?? null;
  });
}

/** The one thank-you after a rating: a dispatchOnce keyed by the review, so a replay or a second tap sends nothing more. */
async function acknowledge(input: ReviewReplyInput, reviewId: string, runSend: Runner): Promise<void> {
  const text = getT('OrderNotices')('reviewThanks');
  await runSend(async () => {
    try {
      const db = createAdminClient({ accountId: input.accountId, role: 'owner' });
      const userId = await resolveAuditUserId(db, input.accountId);
      await dispatchOnce(input.accountId, reviewAckIntentKey(reviewId), () => engineSendText({
        accountId: input.accountId, userId, conversationId: input.conversationId, contactId: input.contactId, text, serviceMessage: true,
      }));
    } catch (error) {
      // A provider rejection sent nothing and is not retried; an uncertain send propagates to the stage checkpoint.
      if (!rejectedByProvider(error)) throw error;
      console.warn('[review] thanks not sent', 'provider_rejected');
    }
  });
}

/**
 * A tap on a star row (rvw:<order>:<product>:<1-5>), called from processInboundActions;
 * only the thank-you runs inside `runSend` (the inbound stage checkpoint). Another
 * contact's tap, another workspace's order, an order that is not delivered or a
 * product that is not on it is ordinary text for the bots.
 */
export async function handleReviewRating(input: ReviewReplyInput & { replyId: string | null | undefined }, runSend: Runner = direct): Promise<ReviewReplyResult> {
  const parsed = parseReviewReplyId(input.replyId);
  if (!parsed) return { handled: false, outcome: 'ignored' };
  const reviewId = await recordRating(input.accountId, input.contactId, input.messageId, parsed.orderId, parsed.productId, parsed.rating, false);
  if (!reviewId) return { handled: false, outcome: 'ignored' };
  await acknowledge(input, reviewId, runSend);
  return { handled: true, outcome: 'rated' };
}

/**
 * A plain text message from a buyer, called from processInboundActions after the shop
 * commands had their turn. Two jobs, in this order:
 * 1. A lone 1 to 5 within seven days of a template review request: the rating (the
 *    template cannot carry star rows). Only the latest request that was sent as a
 *    template counts, and only for a product that has no rating yet.
 * 2. The words after a rating: the next message within 30 minutes of a pending review
 *    of this contact becomes its text; "skip" closes the chance. A shop command
 *    (ORDER, NOTIFY, STOP ...) is never taken and leaves the chance open.
 */
export async function handleReviewText(input: ReviewReplyInput & { text: string | null | undefined }, runSend: Runner = direct,
  now = new Date()): Promise<ReviewReplyResult> {
  const { accountId, contactId, messageId } = input;
  const text = input.text ?? '';
  const digit = parseRatingText(text);
  if (digit !== null) {
    const since = new Date(now.getTime() - REVIEW_TEXT_REPLY_DAYS * 86_400_000);
    const target = await worker(accountId, async (tx) => {
      const [asked] = await tx.$queryRaw<{ order_id: string; reason: string | null }[]>`
        SELECT m.order_id::text AS order_id, m.reason FROM order_messages m
        JOIN orders o ON o.account_id=m.account_id AND o.id=m.order_id
        WHERE m.account_id=${accountId}::uuid AND m.kind='review_request' AND m.status='sent' AND m.updated_at > ${since}
          AND o.contact_id=${contactId}::uuid ORDER BY m.updated_at DESC LIMIT 1`;
      if (asked?.reason !== 'template') return null;
      const product = await reviewProductTx(tx, accountId, asked.order_id);
      return product ? { orderId: asked.order_id, productId: product.id } : null;
    });
    const reviewId = target ? await recordRating(accountId, contactId, messageId, target.orderId, target.productId, digit, true) : null;
    if (reviewId) {
      await acknowledge(input, reviewId, runSend);
      return { handled: true, outcome: 'rated' };
    }
  }

  if (isShopCommand(text)) return { handled: false, outcome: 'ignored' };
  const since = new Date(now.getTime() - REVIEW_BODY_WINDOW_MS);
  const body = isSkipText(text) ? null : cleanReviewBody(text);
  return worker(accountId, async (tx): Promise<ReviewReplyResult> => {
    // One indexed read: the review this very message already completed (a retried job), else this contact's open pending one.
    // Still pending: a published or hidden review is never changed by the buyer.
    const [open] = await tx.$queryRaw<{ id: string; mine: boolean }[]>`
      SELECT id::text AS id, (body_message_id=${messageId}::uuid) AS mine FROM shop_reviews
      WHERE account_id=${accountId}::uuid AND (body_message_id=${messageId}::uuid
        OR (contact_id=${contactId}::uuid AND status='pending' AND body IS NULL AND body_closed_at IS NULL AND rated_at > ${since}))
      ORDER BY (body_message_id=${messageId}::uuid) DESC NULLS LAST, rated_at DESC LIMIT 1 FOR UPDATE`;
    if (!open) return { handled: false, outcome: 'ignored' };
    if (open.mine) return { handled: true, outcome: 'body' };
    await tx.$executeRaw`UPDATE shop_reviews SET body=${body}, body_closed_at=now(), body_message_id=${messageId}::uuid
      WHERE account_id=${accountId}::uuid AND id=${open.id}::uuid`;
    return { handled: true, outcome: body ? 'body' : 'skipped' };
  });
}
