/**
 * commerce.order_followup (design §3, T5): the customer notices after a
 * staff-recorded dispatch or delivery, the feedback request a day after
 * delivery, and the product follow-up after the product's follow_up_after_days.
 *
 * Same pipeline as the appointment messages (Phase 7 D5, D6, D14):
 * - every refusal is decided before dispatchOnce and recorded in the
 *   order_messages ledger (one row per order and kind), so a plain refusal is
 *   never mistaken for an ambiguous send;
 * - the send goes through dispatchOnce('order:<id>:<kind>'): accepted settles
 *   'sent', a provider 4xx 'failed', anything else 'outcome_unknown', never
 *   re-sent; an admin's resolution of a ledger row is final;
 * - consent: refused for a blocked contact, or one who opted out after paying
 *   (after ordering, for an unpaid legacy order); a suspended workspace blocks;
 * - text only inside the customer window (< 23 h); outside it a template,
 *   which must be an approved UTILITY template (MARKETING is never sent). The
 *   product follow-up is always the product's own template. Dispatch,
 *   delivery and feedback have no template setting yet, so outside the window
 *   they are recorded blocked/no_template.
 * Logs carry ids and codes only.
 */
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { appointmentTemplateRefusal } from '@/lib/appointments/template-check';
import { isSuspended } from '@/lib/billing/suspension';
import { getT } from '@/lib/i18n/translate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import { templateSendRefusal } from '@/lib/whatsapp/template-send-params';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import type { MessageTemplate } from '@/types';

export const ORDER_FOLLOWUP_KINDS = ['dispatched', 'delivered', 'feedback', 'product_follow_up'] as const;
export type OrderFollowupKind = (typeof ORDER_FOLLOWUP_KINDS)[number];

/** Dedupe ofu:<orderId>:<kind>, queued by the dispatch and deliver transactions (run_at for the later ones). */
export interface OrderFollowupJobPayload {
  orderId: string;
  kind: OrderFollowupKind;
}

/** The customer window counts as open only below 23h (Phase 7 D6). */
export const OPEN_WINDOW_MS = 23 * 3_600_000;

export type OrderMessageStatus = 'sent' | 'skipped' | 'blocked' | 'failed' | 'outcome_unknown';
export type Outcome = { status: OrderMessageStatus; reason: string | null };

export interface FollowupOrderRow {
  status: string;
  refund_state: string;
  feedback_score: number | null;
}

/** Why this kind no longer applies to the order (a skip code), or null. */
export function followupApplies(order: FollowupOrderRow, kind: OrderFollowupKind): string | null {
  if (kind === 'dispatched') return order.status === 'dispatched' ? null : 'stale_status';
  if (order.status !== 'fulfilled') return 'stale_status';
  if (order.refund_state === 'full' && kind !== 'delivered') return 'refunded';
  if (kind === 'feedback' && order.feedback_score != null) return 'feedback_recorded';
  return null;
}

/** Consent (D5): a blocked contact, or an opt-out after the purchase, refuses the message. */
export function consentRefusal(contact: { blocked_at: Date | null; opted_out_at: Date | null }, purchasedAt: Date): string | null {
  if (contact.blocked_at) return 'contact_blocked';
  if (contact.opted_out_at && contact.opted_out_at.getTime() > purchasedAt.getTime()) return 'opted_out';
  return null;
}

type CheckedTemplate = Pick<MessageTemplate,
  'category' | 'body_text' | 'header_type' | 'header_content' | 'header_media_url' | 'buttons' | 'template_kind' | 'cards' | 'lto'>;

interface TemplateRow extends CheckedTemplate {
  name: string;
  language: string | null;
  status: string | null;
  waba_id: string | null;
}

/**
 * Why a template cannot carry an order message (blocked), or null. Same rules
 * as appointment messages, but a variable URL button is refused outright
 * (an order message has nothing to fill it with).
 */
export function orderTemplateOutcome(template: TemplateRow | null, number: object): Outcome | null {
  if (!template) return { status: 'blocked', reason: 'template_not_found' };
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return { status: 'blocked', reason: 'template_not_approved' };
  const refusal = appointmentTemplateRefusal(template, 'https://invalid.invalid');
  if (refusal === 'not_utility') return { status: 'blocked', reason: 'category' };
  if (refusal) return { status: 'blocked', reason: 'template_refused' };
  if ((template.buttons ?? []).some((b) => b.type === 'URL' && extractVariableIndices(b.url).length > 0))
    return { status: 'blocked', reason: 'template_refused' };
  if (templateSendRefusal(template as { template_kind?: MessageTemplate['template_kind'] }, 'automation'))
    return { status: 'blocked', reason: 'template_refused' };
  try {
    assertTemplateOnNumber(template, number);
  } catch {
    return { status: 'blocked', reason: 'template_wrong_number' };
  }
  return null;
}

/** Positional body values: {{1}} customer name, {{2}} product, {{3}} order reference; cut to what the template uses. */
export function followupBodyValues(template: Pick<MessageTemplate, 'body_text'>, values: string[]): string[] {
  const indices = extractVariableIndices(template.body_text ?? '');
  const count = indices.length ? Math.max(...indices) : 0;
  return Array.from({ length: count }, (_, i) => (values[i] ?? '-').slice(0, 1000) || '-');
}

export function orderReference(order: { id: string; external_id: string | null }): string {
  return order.external_id ? `#${order.external_id}` : order.id.slice(0, 8).toUpperCase();
}

/** Free-form text inside the window (customer-facing, in the workspace's app locale). */
export function followupText(kind: Exclude<OrderFollowupKind, 'product_follow_up'>, values: { ref: string; tracking: string | null }): string {
  const t = getT('OrderNotices');
  if (kind === 'dispatched') return values.tracking ? t('dispatchedWithTracking', { ref: values.ref, tracking: values.tracking }) : t('dispatched', { ref: values.ref });
  if (kind === 'delivered') return t('delivered', { ref: values.ref });
  return t('feedback', { ref: values.ref });
}

type Plan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | { kind: 'send'; contactId: string; conversationId: string; text: string | null; template: TemplateRow | null; values: string[] };

async function settleTx(tx: TenantTransaction, accountId: string, orderId: string, kind: OrderFollowupKind, outcome: Outcome) {
  await tx.$executeRaw`INSERT INTO order_messages(account_id,order_id,kind,status,reason)
    VALUES(${accountId}::uuid,${orderId}::uuid,${kind},${outcome.status},${outcome.reason})
    ON CONFLICT(account_id,order_id,kind) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_at=now()
    WHERE order_messages.resolved_at IS NULL`;
}

const worker = <T,>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

export const intentKey = (orderId: string, kind: OrderFollowupKind) => `order:${orderId}:${kind}`;

async function loadTemplate(tx: TenantTransaction, accountId: string, name: string, language: string | null): Promise<TemplateRow | null> {
  const rows = await tx.$queryRaw<TemplateRow[]>`
    SELECT name, language, status, category, body_text, header_type, header_content, header_media_url, buttons,
      template_kind, cards, lto, waba_id
    FROM message_templates WHERE account_id=${accountId}::uuid AND name=${name}
      AND (${language}::text IS NULL OR lower(language)=lower(${language}::text))
    ORDER BY (upper(coalesce(status,''))='APPROVED') DESC, language LIMIT 1`;
  return rows[0] ?? null;
}

async function plan(accountId: string, orderId: string, kind: OrderFollowupKind, now: Date): Promise<Plan> {
  return worker(accountId, async (tx): Promise<Plan> => {
    const [order] = await tx.$queryRaw<(FollowupOrderRow & {
      id: string; external_id: string | null; contact_id: string | null; conversation_id: string | null;
      whatsapp_config_id: string | null; paid_at: Date | null; created_at: Date; tracking_note: string | null;
    })[]>`
      SELECT id::text AS id, external_id, status, refund_state, feedback_score, contact_id::text AS contact_id,
        conversation_id::text AS conversation_id, whatsapp_config_id::text AS whatsapp_config_id, paid_at, created_at, tracking_note
      FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    if (!order) return { kind: 'done' };
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM order_messages WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind=${kind}`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };

    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${intentKey(orderId, kind)}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return { kind: 'settle', outcome: { status: 'failed', reason: 'provider_rejected' } };
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    const skip = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'skipped', reason } });
    const block = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'blocked', reason } });
    const fail = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'failed', reason } });

    const notApplicable = followupApplies(order, kind);
    if (notApplicable) return skip(notApplicable);
    if (!order.contact_id) return skip('contact_missing');
    const [contact] = await tx.$queryRaw<{ id: string; name: string | null; phone: string | null; wa_user_id: string | null;
      blocked_at: Date | null; opted_out_at: Date | null }[]>`
      SELECT id::text AS id, name, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${order.contact_id}::uuid`;
    if (!contact) return skip('contact_missing');
    const consent = consentRefusal(contact, order.paid_at ?? order.created_at);
    if (consent) return skip(consent);
    if (await isSuspended(tx, accountId)) return block('workspace_suspended');
    if (!resolveContactSendTarget(contact)) return fail('no_address');

    // The order's own conversation first, else the contact's most recent one.
    const [conversation] = await tx.$queryRaw<{ id: string; whatsapp_config_id: string | null; last_customer_at: Date | null }[]>`
      SELECT c.id::text AS id, c.whatsapp_config_id::text AS whatsapp_config_id,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='customer') AS last_customer_at
      FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.contact_id=${contact.id}::uuid
      ORDER BY (c.id=${order.conversation_id}::uuid) DESC NULLS LAST, last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
    if (!conversation) return fail('no_conversation');
    let config;
    try {
      config = await getNumberConfig(tx, accountId, conversation.whatsapp_config_id ?? order.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return fail('number_unavailable');
      throw error;
    }
    if (isNumberDisconnected(config)) return fail('number_unavailable');
    const last = conversation.last_customer_at ? new Date(conversation.last_customer_at).getTime() : NaN;
    const windowOpen = Number.isFinite(last) && now.getTime() - last < OPEN_WINDOW_MS;
    const ref = orderReference(order);

    if (kind !== 'product_follow_up') {
      if (!windowOpen) return block('no_template');
      return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template: null, values: [],
        text: followupText(kind, { ref, tracking: order.tracking_note }) };
    }
    const [product] = await tx.$queryRaw<{ name: string; template: string; language: string | null }[]>`
      SELECT p.name, p.follow_up_template AS template, p.follow_up_template_language AS language FROM order_items i
      JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
      JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid AND p.follow_up_template IS NOT NULL
      ORDER BY i.id LIMIT 1`;
    if (!product) return skip('no_template');
    const template = await loadTemplate(tx, accountId, product.template, product.language);
    const refusal = orderTemplateOutcome(template, config);
    if (refusal) return { kind: 'settle', outcome: refusal };
    return { kind: 'send', contactId: contact.id, conversationId: conversation.id, template, text: null,
      values: [contact.name || '-', product.name, ref] };
  });
}

/**
 * Run one order message job. Throws UncertainDispatchError for an ambiguous
 * send after recording 'outcome_unknown' (the job retries only to re-read the
 * intent, never to send again); on the last attempt it returns quietly so
 * the ledger row is what staff see.
 */
export async function handleOrderFollowupJob(
  accountId: string,
  payload: OrderFollowupJobPayload,
  meta: { attempts: number; maxAttempts: number },
  now = new Date(),
): Promise<Outcome | null> {
  const { orderId, kind } = payload;
  const settle = (outcome: Outcome) => worker(accountId, (tx) => settleTx(tx, accountId, orderId, kind, outcome));
  const uncertain = async () => {
    await settle({ status: 'outcome_unknown', reason: 'uncertain' });
    if (meta.attempts < meta.maxAttempts) throw new UncertainDispatchError();
  };
  const p = await plan(accountId, orderId, kind, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    if (p.uncertain) {
      await uncertain();
      return p.outcome;
    }
    await settle(p.outcome);
    return p.outcome;
  }

  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  const base = { accountId, userId, conversationId: p.conversationId, contactId: p.contactId, serviceMessage: true as const };
  try {
    if (p.text !== null) {
      const text = p.text;
      await dispatchOnce(accountId, intentKey(orderId, kind), () => engineSendText({ ...base, text }));
    } else {
      const template = p.template!;
      const body = followupBodyValues(template, p.values);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, intentKey(orderId, kind), () => engineSendTemplate({
        ...base, templateName: template.name, language: template.language ?? undefined, params: body, bodyValuesOnly: false,
        messageParams: { body, ...(headerVar ? { headerText: (p.values[1] ?? '-').slice(0, 60) } : {}) },
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await uncertain();
      return { status: 'outcome_unknown', reason: 'uncertain' };
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const outcome: Outcome = { status: 'failed', reason: 'provider_rejected' };
      await settle(outcome);
      return outcome;
    }
    throw error;
  }
  const outcome: Outcome = { status: 'sent', reason: null };
  await settle(outcome);
  return outcome;
}
