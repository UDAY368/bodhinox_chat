/**
 * Store plan Phase 3, package 2: the jobs and the inbound reply behind the
 * abandoned-cart reminder (commerce.abandoned_cart) and the COD confirmation
 * (commerce.cod_confirm, and the customer's Yes / Cancel tap).
 *
 * Same pipeline as the order notices (order-followup.ts): every refusal is
 * decided before dispatchOnce and recorded (the session's reminder_skip, or the
 * order_messages ledger row 'cod_confirm'), the send goes through dispatchOnce
 * with a stable key and an uncertain outcome is recorded for staff, never
 * re-sent. Free text or buttons only inside the customer window (< 23 h);
 * outside it the workspace's approved template of the notice kind
 * (abandoned_cart: MARKETING, cod_confirm: UTILITY); none set -> not sent.
 * Logs carry ids and codes only: no phone numbers, message text or carts.
 */
import { emitDomainEvent } from '@/lib/events/emit';
import { createAdminClient } from '@/lib/data/admin';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isSuspended } from '@/lib/billing/suspension';
import { engineSendInteractive, engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import type { TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { getT } from '@/lib/i18n/translate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import {
  abandonedCartSkip, codConfirmButtonId, codTransition, isCodConfirmation, parseCodConfirmReply,
} from './cart-followups';
import {
  consentRefusal, followupBodyValues, loadTemplate, noticeTemplate, NOTICE_TEMPLATE_CATEGORY, OPEN_WINDOW_MS, orderReference,
  orderTemplateOutcome, worker, type Outcome, type TemplateRow,
} from './order-followup';
import { linkMessageText } from './storefront';
import { deriveStorefrontToken, storefrontUrl } from './storefront-token';

export interface ContactRow {
  id: string; name: string | null; phone: string | null; wa_user_id: string | null; blocked_at: Date | null; opted_out_at: Date | null;
}

export interface ConversationRow {
  id: string; whatsapp_config_id: string | null; channel: string; bot_paused: boolean; last_customer_at: Date | null;
}

/** The contact's conversation to write in: the preferred one first, else their most recent WhatsApp one. */
export async function pickConversation(tx: TenantTransaction, accountId: string, contactId: string, preferred: string | null): Promise<ConversationRow | null> {
  const [row] = await tx.$queryRaw<ConversationRow[]>`
    SELECT c.id::text AS id, c.whatsapp_config_id::text AS whatsapp_config_id, c.channel, c.bot_paused,
      (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_at
    FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.contact_id=${contactId}::uuid
      AND (c.channel='whatsapp' OR c.id=${preferred}::uuid)
    ORDER BY (c.id=${preferred}::uuid) DESC NULLS LAST, last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
  return row ?? null;
}

export const windowOpen = (c: ConversationRow, now: Date) =>
  c.last_customer_at !== null && now.getTime() - new Date(c.last_customer_at).getTime() < OPEN_WINDOW_MS;

export const rejectedByProvider = (error: unknown) => error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500;

// ---------------------------------------------------------------------------
// Abandoned cart

export interface AbandonedCartJobPayload { sessionId: string }

type CartPlan =
  | { kind: 'done' }
  | { kind: 'skip'; reason: string }
  | { kind: 'sent' }
  | { kind: 'send'; contactId: string; conversationId: string; text: string | null; template: TemplateRow | null; values: string[] };

export const abandonedCartIntentKey = (sessionId: string) => `session:${sessionId}:abandoned_cart`;

async function planAbandonedCart(accountId: string, sessionId: string, now: Date): Promise<CartPlan> {
  return worker(accountId, async (tx): Promise<CartPlan> => {
    const [session] = await tx.$queryRaw<{ id: string; contact_id: string; conversation_id: string | null; whatsapp_config_id: string | null;
      purpose: string; token_epoch: number; expires_at: Date; revoked_at: Date | null; order_id: string | null; lines: number; reminded_at: Date | null }[]>`
      SELECT id::text AS id, contact_id::text AS contact_id, conversation_id::text AS conversation_id,
        whatsapp_config_id::text AS whatsapp_config_id, purpose, token_epoch, expires_at, revoked_at, order_id::text AS order_id,
        jsonb_array_length(cart) AS lines, reminded_at
      FROM storefront_sessions WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid`;
    if (!session) return { kind: 'done' };
    const [settings] = await tx.$queryRaw<{ delay: number | null; checkout_enabled: boolean }[]>`
      SELECT abandoned_cart_delay_minutes AS delay, checkout_enabled FROM commerce_settings WHERE account_id=${accountId}::uuid`;
    const skip = abandonedCartSkip({
      delayMinutes: settings?.delay ?? null, checkoutEnabled: settings?.checkout_enabled ?? false, purpose: session.purpose,
      revoked: session.revoked_at !== null, expired: session.expires_at.getTime() <= now.getTime(), orderId: session.order_id,
      cartLines: session.lines, remindedAt: session.reminded_at,
    });
    if (skip === 'already_reminded') return { kind: 'done' };
    if (skip) return { kind: 'skip', reason: skip };
    // Still a filled cart with no order after the store's delay: the feed's cart.abandoned
    // (rules, flows, webhooks), once per session whatever happens to the reminder below.
    await emitDomainEvent(tx, {
      accountId, type: 'cart.abandoned', subject: { kind: 'cart', id: session.id }, contactId: session.contact_id,
      data: { session_id: session.id, item_count: session.lines, conversation_id: session.conversation_id },
      dedupeKey: `cart:${session.id}:abandoned`,
    });

    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid
        AND idempotency_key=${`${accountId}:${abandonedCartIntentKey(sessionId)}`}`;
    if (intent?.status === 'accepted') return { kind: 'sent' };
    if (intent?.status === 'failed') return { kind: 'skip', reason: 'provider_rejected' };
    if (intent) return { kind: 'skip', reason: 'outcome_unknown' };

    const [contact] = await tx.$queryRaw<ContactRow[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${session.contact_id}::uuid`;
    if (!contact) return { kind: 'skip', reason: 'contact_missing' };
    // A marketing message: any opt-out (not only one after the purchase) and a block refuse it.
    const consent = consentRefusal(contact, new Date(0));
    if (consent) return { kind: 'skip', reason: consent };
    if (await isSuspended(tx, accountId)) return { kind: 'skip', reason: 'workspace_suspended' };
    if (!resolveContactSendTarget(contact)) return { kind: 'skip', reason: 'no_address' };
    const conversation = await pickConversation(tx, accountId, contact.id, session.conversation_id);
    if (!conversation) return { kind: 'skip', reason: 'no_conversation' };
    // Not a service message: an agent's takeover of the chat holds it back.
    if (conversation.bot_paused) return { kind: 'skip', reason: 'bot_paused' };
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id ?? session.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return { kind: 'skip', reason: 'number_unavailable' };
      throw error;
    }
    if (isNumberDisconnected(config)) return { kind: 'skip', reason: 'number_unavailable' };

    const url = storefrontUrl(deriveStorefrontToken(session.id, session.token_epoch));
    if (windowOpen(conversation, now))
      return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template: null, values: [],
        text: linkMessageText(getT('OrderNotices')('abandonedCart'), url) };
    const setting = await noticeTemplate(tx, accountId, 'abandoned_cart');
    if (!setting) return { kind: 'skip', reason: 'no_template' };
    const template = await loadTemplate(tx, accountId, setting.name, setting.language);
    const refusal = orderTemplateOutcome(template, config, NOTICE_TEMPLATE_CATEGORY.abandoned_cart);
    if (refusal || !template) return { kind: 'skip', reason: refusal?.reason ?? 'template_not_found' };
    // {{1}} customer name, {{2}} the checkout link (a variable URL button is not supported, so the link is in the body).
    return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template, text: null, values: [contact.name || '-', url] };
  });
}

/**
 * One abandoned-cart reminder. The session records the result: reminded_at once
 * sent, else reminder_skip with the reason (outcome_unknown for an uncertain
 * send, which staff reconcile; it is never sent again).
 */
export async function handleAbandonedCartJob(accountId: string, payload: AbandonedCartJobPayload, now = new Date()): Promise<string | null> {
  const { sessionId } = payload;
  const record = (sent: boolean, reason: string | null) => worker(accountId, (tx) => tx.$executeRaw`
    UPDATE storefront_sessions SET reminded_at=${sent ? now : null}, reminder_skip=${reason}
    WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid AND reminded_at IS NULL`);
  const p = await planAbandonedCart(accountId, sessionId, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'skip') {
    await record(false, p.reason);
    return p.reason;
  }
  if (p.kind === 'sent') {
    await record(true, null);
    return 'sent';
  }
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId };
  try {
    if (p.text !== null) {
      const text = p.text;
      await dispatchOnce(accountId, abandonedCartIntentKey(sessionId), () => engineSendText({ ...base, text }));
    } else {
      const template = p.template!;
      const body = followupBodyValues(template, p.values);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, abandonedCartIntentKey(sessionId), () => engineSendTemplate({
        ...base, templateName: template.name, language: template.language ?? undefined, params: body, bodyValuesOnly: false,
        messageParams: { body, ...(headerVar ? { headerText: (p.values[0] ?? '-').slice(0, 60) } : {}) },
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await record(false, 'outcome_unknown');
      return 'outcome_unknown';
    }
    if (rejectedByProvider(error)) {
      await record(false, 'provider_rejected');
      return 'provider_rejected';
    }
    throw error;
  }
  await record(true, null);
  return 'sent';
}

// ---------------------------------------------------------------------------
// COD confirmation

export interface CodConfirmJobPayload { orderId: string }

export const codConfirmIntentKey = (orderId: string) => `order:${orderId}:cod_confirm`;
export const codConfirmReplyIntentKey = (orderId: string) => `order:${orderId}:cod_confirm_reply`;

type CodPlan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | { kind: 'buttons'; contactId: string; conversationId: string; ref: string }
  | { kind: 'template'; contactId: string; conversationId: string; template: TemplateRow; values: string[] };

async function settleCod(accountId: string, orderId: string, outcome: Outcome) {
  await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO order_messages(account_id,order_id,kind,status,reason)
    VALUES(${accountId}::uuid,${orderId}::uuid,'cod_confirm',${outcome.status},${outcome.reason})
    ON CONFLICT(account_id,order_id,kind) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_at=now()
    WHERE order_messages.resolved_at IS NULL`);
}

async function planCodConfirm(accountId: string, orderId: string, now: Date): Promise<CodPlan> {
  return worker(accountId, async (tx): Promise<CodPlan> => {
    const [order] = await tx.$queryRaw<{ id: string; external_id: string | null; status: string; payment_method: string;
      cod_confirmation: string | null; contact_id: string | null; conversation_id: string | null; whatsapp_config_id: string | null;
      created_at: Date }[]>`
      SELECT id::text AS id, external_id, status, payment_method, cod_confirmation, contact_id::text AS contact_id,
        conversation_id::text AS conversation_id, whatsapp_config_id::text AS whatsapp_config_id, created_at
      FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    // Answered, cancelled or not a COD order any more: nothing to ask.
    if (!order || order.payment_method !== 'cod' || order.cod_confirmation !== 'pending' || !['new', 'confirmed'].includes(order.status))
      return { kind: 'done' };
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM order_messages WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='cod_confirm'`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${codConfirmIntentKey(orderId)}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return { kind: 'settle', outcome: { status: 'failed', reason: 'provider_rejected' } };
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    const skip = (reason: string): CodPlan => ({ kind: 'settle', outcome: { status: 'skipped', reason } });
    const block = (reason: string): CodPlan => ({ kind: 'settle', outcome: { status: 'blocked', reason } });
    const fail = (reason: string): CodPlan => ({ kind: 'settle', outcome: { status: 'failed', reason } });
    if (!order.contact_id) return skip('contact_missing');
    const [contact] = await tx.$queryRaw<ContactRow[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${order.contact_id}::uuid`;
    if (!contact) return skip('contact_missing');
    const consent = consentRefusal(contact, order.created_at);
    if (consent) return skip(consent);
    if (await isSuspended(tx, accountId)) return block('workspace_suspended');
    if (!resolveContactSendTarget(contact)) return fail('no_address');
    const conversation = await pickConversation(tx, accountId, contact.id, order.conversation_id);
    if (!conversation) return fail('no_conversation');
    // The button message is a bot message: an agent's takeover holds it back (staff see the order as pending).
    if (conversation.bot_paused) return block('bot_paused');
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id ?? order.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return fail('number_unavailable');
      throw error;
    }
    if (isNumberDisconnected(config)) return fail('number_unavailable');
    const ref = orderReference(order);
    if (windowOpen(conversation, now)) return { kind: 'buttons', contactId: contact.id, conversationId: conversation.id, ref };
    // A template cannot carry the per-order button ids, so it only asks; the customer's answer reaches staff in the chat.
    const setting = await noticeTemplate(tx, accountId, 'cod_confirm');
    if (!setting) return block('no_template');
    const template = await loadTemplate(tx, accountId, setting.name, setting.language);
    const refusal = orderTemplateOutcome(template, config, NOTICE_TEMPLATE_CATEGORY.cod_confirm);
    if (refusal || !template) return { kind: 'settle', outcome: refusal ?? { status: 'blocked', reason: 'template_not_found' } };
    return { kind: 'template', contactId: contact.id, conversationId: conversation.id, template, values: [contact.name || '-', ref] };
  });
}

/** The message of a COD confirmation: a short question and the two buttons. */
export function codConfirmPayload(orderId: string, ref: string) {
  const t = getT('OrderNotices');
  return {
    kind: 'buttons' as const,
    body: t('codConfirmBody', { ref }),
    buttons: [
      { id: codConfirmButtonId(orderId, 'yes'), title: t('codConfirmYes') },
      { id: codConfirmButtonId(orderId, 'no'), title: t('codConfirmNo') },
    ],
  };
}

/** Run one COD confirmation job. An uncertain send is recorded in the order_messages ledger and never repeated. */
export async function handleCodConfirmJob(
  accountId: string, payload: CodConfirmJobPayload, meta: { attempts: number; maxAttempts: number }, now = new Date(),
): Promise<Outcome | null> {
  const { orderId } = payload;
  const uncertain = async () => {
    await settleCod(accountId, orderId, { status: 'outcome_unknown', reason: 'uncertain' });
    if (meta.attempts < meta.maxAttempts) throw new UncertainDispatchError();
  };
  const p = await planCodConfirm(accountId, orderId, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    if (p.uncertain) {
      await uncertain();
      return p.outcome;
    }
    await settleCod(accountId, orderId, p.outcome);
    return p.outcome;
  }
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId };
  try {
    if (p.kind === 'buttons') {
      await dispatchOnce(accountId, codConfirmIntentKey(orderId), () => engineSendInteractive({ ...base, payload: codConfirmPayload(orderId, p.ref) }));
    } else {
      const template = p.template;
      const body = followupBodyValues(template, p.values);
      await dispatchOnce(accountId, codConfirmIntentKey(orderId), () => engineSendTemplate({
        ...base, serviceMessage: true, templateName: template.name, language: template.language ?? undefined, params: body,
        bodyValuesOnly: false, messageParams: { body },
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await uncertain();
      return { status: 'outcome_unknown', reason: 'uncertain' };
    }
    if (rejectedByProvider(error)) {
      const outcome: Outcome = { status: 'failed', reason: 'provider_rejected' };
      await settleCod(accountId, orderId, outcome);
      return outcome;
    }
    throw error;
  }
  const outcome: Outcome = { status: 'sent', reason: null };
  await settleCod(accountId, orderId, outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// The customer's answer

export interface CodConfirmReplyInput {
  accountId: string;
  /** The sender, as resolved by the inbound pipeline. */
  contactId: string;
  conversationId: string;
  replyId: string | null | undefined;
}

export interface CodConfirmReplyResult {
  /** True when the tap was a valid answer from the order's own contact: bots and the away message then stay silent. */
  handled: boolean;
  outcome: 'confirmed' | 'declined' | 'ignored';
}

type Claim = { kind: 'not_ours' } | { kind: 'applied'; state: 'confirmed' | 'declined'; ref: string };

/**
 * An inbound tap on a COD confirmation button (called from processInboundActions;
 * only the reply send runs inside its stage checkpoint). The tap counts only
 * when the sender is the order's own contact in this workspace and the order is
 * still open. Pending becomes confirmed (yes) or declined (no) once, with an
 * order event; a declined order is NOT cancelled (staff decide). A replay
 * finds the answer already stored and only re-runs the one reply, which
 * dispatchOnce sends once. A later tap that contradicts the stored answer is ignored.
 */
export async function handleCodConfirmReply(
  input: CodConfirmReplyInput,
  /** Wraps the one send (the inbound job passes its stage checkpoint); the claim before it is replay-safe on its own. */
  runSend: (send: () => Promise<unknown>) => Promise<unknown> = (send) => send(),
): Promise<CodConfirmReplyResult> {
  const parsed = parseCodConfirmReply(input.replyId);
  if (!parsed) return { handled: false, outcome: 'ignored' };
  const { accountId } = input;
  const claim = await worker(accountId, async (tx): Promise<Claim> => {
    const [order] = await tx.$queryRaw<{ id: string; external_id: string | null; status: string; payment_method: string;
      contact_id: string | null; cod_confirmation: string | null }[]>`
      SELECT id::text AS id, external_id, status, payment_method, contact_id::text AS contact_id, cod_confirmation
      FROM orders WHERE account_id=${accountId}::uuid AND id=${parsed.orderId}::uuid FOR UPDATE`;
    if (!order || order.contact_id !== input.contactId || order.payment_method !== 'cod' || !isCodConfirmation(order.cod_confirmation)
      || !['new', 'confirmed'].includes(order.status)) return { kind: 'not_ours' };
    const next = codTransition(order.cod_confirmation, parsed.choice);
    if (next) {
      await tx.$executeRaw`UPDATE orders SET cod_confirmation=${next} WHERE account_id=${accountId}::uuid AND id=${order.id}::uuid`;
      await tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor)
        VALUES(${accountId}::uuid,${order.id}::uuid,${next === 'confirmed' ? 'cod_customer_confirmed' : 'cod_customer_declined'},'customer')`;
      return { kind: 'applied', state: next, ref: orderReference(order) };
    }
    // Already answered: the same answer again is a replay (re-run the reply stage); the opposite one changes nothing.
    const same = order.cod_confirmation === (parsed.choice === 'yes' ? 'confirmed' : 'declined');
    return same ? { kind: 'applied', state: order.cod_confirmation as 'confirmed' | 'declined', ref: orderReference(order) } : { kind: 'not_ours' };
  });
  if (claim.kind === 'not_ours') return { handled: false, outcome: 'ignored' };

  const t = getT('OrderNotices');
  const text = claim.state === 'confirmed' ? t('codConfirmThanksYes', { ref: claim.ref }) : t('codConfirmThanksNo', { ref: claim.ref });
  await runSend(async () => {
    try {
      const db = createAdminClient({ accountId, role: 'owner' });
      const userId = await resolveAuditUserId(db, accountId);
      await dispatchOnce(accountId, codConfirmReplyIntentKey(parsed.orderId), () => engineSendText({
        accountId, userId, conversationId: input.conversationId, contactId: input.contactId, text, serviceMessage: true,
      }));
    } catch (error) {
      // A provider rejection sent nothing and is not retried; an uncertain send propagates to the stage checkpoint.
      if (!rejectedByProvider(error)) throw error;
      console.warn('[cod-confirm] reply not sent', 'provider_rejected');
    }
  });
  return { handled: true, outcome: claim.state };
}
