import { Prisma } from '@prisma/client';
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { automationTemplateRefusal } from '@/lib/automations/template-check';
import { pickBestPhoneMatch } from '@/lib/contacts/dedupe';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { normalizePhone, parseInternationalPhone, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { templateSendRefusal } from '@/lib/whatsapp/template-send-params';
import { formatMoney, isCurrencyCode } from './money';

/**
 * Store events (Shopify, WooCommerce) → WhatsApp template sends.
 *
 * recordCommerceEvent stores each event once (per dedupe key), resolves or
 * creates the contact by phone, applies the consent rule and, when an enabled
 * rule exists, queues a durable 'commerce.event_send' job in the same
 * transaction. The job sends the rule's template once, through an outbound
 * intent keyed by the event id, so an ambiguous outcome is never re-sent.
 *
 * Consent rule (checked when recorded, and again just before sending):
 *  - no usable phone                     → skipped 'no_phone'
 *  - contact blocked                     → skipped 'contact_blocked' (no automated messages at all)
 *  - marketing send = template category MARKETING, or any checkout_abandoned:
 *      contact opted out                 → skipped 'contact_opted_out'
 *      store says no consent (false)     → skipped 'no_marketing_consent'
 *      contact created by this event and
 *      store consent not true            → skipped 'no_marketing_consent'
 *    i.e. marketing needs marketingConsent === true, or an existing contact
 *    that has not opted out and was not refused by the store.
 *  - utility / transactional templates go to any contact that is not blocked.
 */

export const COMMERCE_EVENT_JOB = 'commerce.event_send';
export const COMMERCE_SOURCES = ['shopify', 'woocommerce'] as const;
export const COMMERCE_EVENTS = ['order_created', 'order_paid', 'order_fulfilled', 'order_cancelled', 'checkout_abandoned'] as const;
export type CommerceSource = (typeof COMMERCE_SOURCES)[number];
export type CommerceEventName = (typeof COMMERCE_EVENTS)[number];
export type CommerceEventStatus = 'received' | 'scheduled' | 'sent' | 'skipped' | 'failed';

/** Reasons stored in commerce_events.reason (translated under Commerce.events.reasons). */
export type CommerceEventReason =
  | 'no_rule' | 'rule_disabled' | 'no_phone' | 'contact_blocked' | 'contact_opted_out' | 'no_marketing_consent'
  | 'template_not_found' | 'template_refused' | 'number_unavailable' | 'bot_paused' | 'checkout_completed'
  | 'contact_missing' | 'provider_rejected' | 'outcome_unknown';

/** Flat, minimised event fields a rule can map into template variables. */
export type CommerceEventPayload = Record<string, string | number | boolean | null>;

export interface RecordCommerceEventInput {
  accountId: string;
  source: CommerceSource;
  event: CommerceEventName;
  /** Store order / checkout id. */
  externalId?: string | null;
  /** Unique per store event, e.g. `shopify:<shop>:orders/paid:<order id>`. */
  dedupeKey: string;
  /**
   * Only fields a template may show (order_number, total_minor, currency,
   * status_url, tracking_url, checkout_url, checkout_token, item_count…).
   * Keys are snake_case, values scalars; nested values and extra keys are
   * dropped. For checkout_abandoned include `checkout_token`, and include the
   * same `checkout_token` on the order events of a completed checkout.
   */
  payload: Record<string, unknown>;
  /** International format with a leading +. */
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  /** The store's marketing consent for this customer, when it reports one. */
  marketingConsent?: boolean | null;
}

export interface RecordCommerceEventResult {
  eventId: string;
  duplicate: boolean;
  status: CommerceEventStatus;
  reason: string | null;
  contactId: string | null;
  scheduledFor: Date | null;
}

const MAX_FIELDS = 50;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps flat scalar fields only and adds a formatted `<x>` beside each `<x>_minor` amount. */
export function minimiseCommercePayload(payload: Record<string, unknown>, name?: string | null): CommerceEventPayload {
  const out: CommerceEventPayload = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (Object.keys(out).length >= MAX_FIELDS || !FIELD.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 1000);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  const trimmedName = name?.trim();
  if (trimmedName && out.customer_name === undefined) out.customer_name = trimmedName.slice(0, 200);
  const currency = typeof out.currency === 'string' ? out.currency.toUpperCase() : '';
  if (isCurrencyCode(currency)) {
    for (const [key, value] of Object.entries(out)) {
      const base = key.endsWith('_minor') ? key.slice(0, -'_minor'.length) : '';
      if (base && FIELD.test(base) && out[base] === undefined && typeof value === 'number' && Number.isSafeInteger(value))
        out[base] = formatMoney(value, currency, 'en');
    }
  }
  return out;
}

/** Validates a rule's variable map: {"1": "order_number", …}, indexes 1..20, field names. */
export function isVariableMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([k, v]) => /^([1-9]|1\d|20)$/.test(k) && typeof v === 'string' && FIELD.test(v));
}

/** Positional body values for the template: variable N gets payload[map[N]]; gaps and blanks become "-". */
export function resolveTemplateVariables(variableMap: unknown, payload: CommerceEventPayload): string[] {
  if (!isVariableMap(variableMap)) return [];
  const indexes = Object.keys(variableMap).map(Number);
  const count = indexes.length ? Math.max(...indexes) : 0;
  return Array.from({ length: count }, (_, i) => {
    const field = variableMap[String(i + 1)];
    const value = field === undefined ? undefined : payload[field];
    const text = value === null || value === undefined ? '' : String(value).trim();
    return text ? text.slice(0, 1000) : '-';
  });
}

export function isMarketingSend(event: CommerceEventName, templateCategory: string | null | undefined): boolean {
  return event === 'checkout_abandoned' || (templateCategory ?? '').toUpperCase() === 'MARKETING';
}

/** The consent rule above, as a pure function. Null means the send may go ahead. */
export function consentRefusal(input: {
  event: CommerceEventName;
  templateCategory: string | null | undefined;
  contact: { blocked_at: Date | null; opted_out_at: Date | null; createdNow: boolean } | null;
  marketingConsent?: boolean | null;
}): CommerceEventReason | null {
  if (!input.contact) return 'no_phone';
  if (input.contact.blocked_at) return 'contact_blocked';
  if (!isMarketingSend(input.event, input.templateCategory)) return null;
  if (input.contact.opted_out_at) return 'contact_opted_out';
  if (input.marketingConsent === false) return 'no_marketing_consent';
  if (input.contact.createdNow && input.marketingConsent !== true) return 'no_marketing_consent';
  return null;
}

type ContactRow = { id: string; phone: string; blocked_at: Date | null; opted_out_at: Date | null };

/**
 * Finds the contact by phone, or creates it from the store's data. A contact
 * created here is recorded as the event's created_contact_id (provenance), so a
 * store GDPR redaction can later erase it; an existing contact is never marked.
 */
async function resolveContact(
  tx: TenantTransaction, accountId: string, phone: string | null | undefined, name: string | null | undefined, email: string | null | undefined,
  eventId: string,
): Promise<(ContactRow & { createdNow: boolean }) | null> {
  const sanitized = parseInternationalPhone(phone ?? null);
  const normalized = sanitized ? normalizePhone(sanitized) : '';
  if (!normalized) return null;
  const find = async () => pickBestPhoneMatch(await tx.$queryRaw<ContactRow[]>`
    SELECT id,phone,blocked_at,opted_out_at FROM contacts
    WHERE account_id=${accountId}::uuid AND phone_normalized IN (${Prisma.join(phoneVariants(normalized))})`, sanitized!);
  const existing = await find();
  if (existing) return { ...existing, createdNow: false };
  const cleanEmail = email && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(email.trim()) ? email.trim() : null;
  // Audit user: the default number's owner, else the account owner (as the public API does).
  const created = await tx.$queryRaw<ContactRow[]>`
    INSERT INTO contacts(account_id,user_id,phone,name,email)
    SELECT ${accountId}::uuid,
      COALESCE((SELECT user_id FROM whatsapp_config WHERE account_id=${accountId}::uuid AND is_default LIMIT 1), a.owner_user_id),
      ${sanitized}, ${(name?.trim() || sanitized)!.slice(0, 200)}, ${cleanEmail}
    FROM accounts a WHERE a.id=${accountId}::uuid
    ON CONFLICT DO NOTHING RETURNING id,phone,blocked_at,opted_out_at`;
  if (created[0]) {
    await tx.$executeRaw`UPDATE commerce_events SET created_contact_id=${created[0].id}::uuid
      WHERE id=${eventId}::uuid AND account_id=${accountId}::uuid`;
    return { ...created[0], createdNow: true };
  }
  const raced = await find();
  return raced ? { ...raced, createdNow: false } : null;
}

async function templateCategory(tx: TenantTransaction, accountId: string, name: string, language: string | null): Promise<string | null | undefined> {
  const rows = await tx.$queryRaw<{ category: string | null; language: string | null }[]>`
    SELECT category,language FROM message_templates WHERE account_id=${accountId}::uuid AND name=${name}`;
  if (!rows.length) return undefined;
  const exact = language ? rows.find((r) => (r.language ?? '').toLowerCase() === language.toLowerCase()) : undefined;
  return (exact ?? rows[0]).category;
}

/**
 * Records a store event once and schedules its template send. `tx` must be a
 * worker-role tenant transaction:
 *   withTenant({ accountId, role: 'owner' }, tx => recordCommerceEvent(tx, input), getWorkerPrisma())
 * The send job is inserted in the same transaction, so it commits with the event.
 */
export async function recordCommerceEvent(tx: TenantTransaction, input: RecordCommerceEventInput): Promise<RecordCommerceEventResult> {
  if (!UUID.test(input.accountId)) throw new Error('Invalid account');
  if (!(COMMERCE_SOURCES as readonly string[]).includes(input.source) || !(COMMERCE_EVENTS as readonly string[]).includes(input.event))
    throw new Error('Invalid commerce event');
  const dedupeKey = (input.dedupeKey ?? '').trim();
  if (!dedupeKey || dedupeKey.length > 300) throw new Error('Invalid commerce event dedupe key');
  const externalId = input.externalId ? String(input.externalId).slice(0, 200) : null;
  const payload = minimiseCommercePayload(input.payload, input.name);

  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO commerce_events(account_id,source,event,external_id,dedupe_key,payload)
    VALUES(${input.accountId}::uuid,${input.source},${input.event},${externalId},${dedupeKey},${JSON.stringify(payload)}::jsonb)
    ON CONFLICT(account_id,dedupe_key) DO NOTHING RETURNING id`;
  if (!inserted.length) {
    const [existing] = await tx.$queryRaw<{ id: string; status: CommerceEventStatus; reason: string | null; contact_id: string | null; scheduled_for: Date | null }[]>`
      SELECT id,status,reason,contact_id,scheduled_for FROM commerce_events WHERE account_id=${input.accountId}::uuid AND dedupe_key=${dedupeKey}`;
    if (!existing) throw new Error('Commerce event could not be recorded');
    return { eventId: existing.id, duplicate: true, status: existing.status, reason: existing.reason, contactId: existing.contact_id, scheduledFor: existing.scheduled_for };
  }
  const eventId = inserted[0].id;
  const contact = await resolveContact(tx, input.accountId, input.phone, input.name, input.email, eventId);
  const contactId = contact?.id ?? null;

  const finish = async (status: CommerceEventStatus, reason: CommerceEventReason | null, scheduledFor: Date | null = null) => {
    // The consent inputs are kept so the send-time re-check applies the same rule (see handleCommerceEventJob).
    await tx.$executeRaw`UPDATE commerce_events SET status=${status},reason=${reason},contact_id=${contactId}::uuid,scheduled_for=${scheduledFor},
        marketing_consent=${typeof input.marketingConsent === 'boolean' ? input.marketingConsent : null}::boolean,
        created_contact_id=COALESCE(created_contact_id, ${contact?.createdNow ? contactId : null}::uuid)
      WHERE id=${eventId}::uuid AND account_id=${input.accountId}::uuid`;
    return { eventId, duplicate: false, status, reason, contactId, scheduledFor };
  };

  const [rule] = await tx.$queryRaw<{ enabled: boolean; template_name: string; template_language: string | null; delay_minutes: number }[]>`
    SELECT enabled,template_name,template_language,delay_minutes FROM commerce_event_rules
    WHERE account_id=${input.accountId}::uuid AND source=${input.source} AND event=${input.event}`;
  if (!rule) return finish('skipped', 'no_rule');
  if (!rule.enabled) return finish('skipped', 'rule_disabled');
  const category = await templateCategory(tx, input.accountId, rule.template_name, rule.template_language);
  if (category === undefined) return finish('skipped', 'template_not_found');
  const refusal = consentRefusal({ event: input.event, templateCategory: category, contact, marketingConsent: input.marketingConsent });
  if (refusal) return finish('skipped', refusal);

  const scheduledFor = new Date(Date.now() + rule.delay_minutes * 60_000);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${COMMERCE_EVENT_JOB},${input.accountId}::uuid,${JSON.stringify({ eventId })}::jsonb,${`commerce:${eventId}`},${scheduledFor})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return finish('scheduled', null, scheduledFor);
}

// ---------------------------------------------------------------------------
// Job: send the scheduled template.

type EventRow = {
  id: string; source: CommerceSource; event: CommerceEventName; status: CommerceEventStatus; payload: CommerceEventPayload;
  contact_id: string | null; created_at: Date; marketing_consent: boolean | null; created_contact_id: string | null;
};
type RuleRow = { enabled: boolean; template_name: string; template_language: string | null; whatsapp_config_id: string | null; variable_map: unknown };

async function settle(accountId: string, eventId: string, status: CommerceEventStatus, reason: CommerceEventReason | null) {
  // An admin's resolution is final; the job never overwrites it.
  await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`
    UPDATE commerce_events SET status=${status},reason=${reason}
    WHERE id=${eventId}::uuid AND account_id=${accountId}::uuid AND resolved_at IS NULL`, getWorkerPrisma());
}

/** True when the abandoned checkout has since become an order. */
async function checkoutCompleted(tx: TenantTransaction, accountId: string, event: EventRow): Promise<boolean> {
  const token = typeof event.payload.checkout_token === 'string' ? event.payload.checkout_token : '';
  if (!token) return false;
  const rows = await tx.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM commerce_events
      WHERE account_id=${accountId}::uuid AND source=${event.source} AND event<>'checkout_abandoned'
        AND payload->>'checkout_token'=${token}
    UNION ALL
    SELECT 1 FROM orders WHERE account_id=${accountId}::uuid AND source=${event.source} AND external_id=${token}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Handler for COMMERCE_EVENT_JOB (payload { eventId }). Runs inside the job's
 * tenant scope (withJobScope). Only a 'scheduled' event is sent; everything
 * else is a no-op, so a redelivered job never sends twice.
 */
export async function handleCommerceEventJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const eventId = typeof payload.eventId === 'string' && UUID.test(payload.eventId) ? payload.eventId : null;
  if (!eventId) throw new Error('Invalid commerce event job');

  type Plan =
    | { kind: 'skip' | 'fail'; reason: CommerceEventReason }
    | { kind: 'settled'; status: CommerceEventStatus; reason: CommerceEventReason | null }
    | { kind: 'send'; event: EventRow; rule: RuleRow; contactPhone: string; configId: string; wabaId: string | null }
    | { kind: 'noop' };
  const plan = await withTenant({ accountId, role: 'owner' }, async (tx): Promise<Plan> => {
    const [event] = await tx.$queryRaw<EventRow[]>`
      SELECT id,source,event,status,payload,contact_id,created_at,marketing_consent,created_contact_id FROM commerce_events
      WHERE id=${eventId}::uuid AND account_id=${accountId}::uuid AND resolved_at IS NULL`;
    if (!event || event.status !== 'scheduled') return { kind: 'noop' };
    // A previous attempt already claimed the send (e.g. the worker crashed mid-send):
    // its intent decides the outcome, never a fresh plan that could mark it skipped.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:commerce:${eventId}`}`;
    if (intent?.status === 'accepted') return { kind: 'settled', status: 'sent', reason: null };
    if (intent?.status === 'failed') return { kind: 'settled', status: 'failed', reason: 'provider_rejected' };
    if (intent) return { kind: 'settled', status: 'scheduled', reason: 'outcome_unknown' };
    const [rule] = await tx.$queryRaw<RuleRow[]>`
      SELECT enabled,template_name,template_language,whatsapp_config_id,variable_map FROM commerce_event_rules
      WHERE account_id=${accountId}::uuid AND source=${event.source} AND event=${event.event}`;
    if (!rule?.enabled) return { kind: 'skip', reason: 'rule_disabled' };
    if (event.event === 'checkout_abandoned' && (await checkoutCompleted(tx, accountId, event)))
      return { kind: 'skip', reason: 'checkout_completed' };
    const [contact] = event.contact_id ? await tx.$queryRaw<ContactRow[]>`
      SELECT id,phone,blocked_at,opted_out_at FROM contacts WHERE id=${event.contact_id}::uuid AND account_id=${accountId}::uuid` : [];
    if (!contact) return { kind: 'skip', reason: 'contact_missing' };
    const category = await templateCategory(tx, accountId, rule.template_name, rule.template_language);
    if (category === undefined) return { kind: 'fail', reason: 'template_not_found' };
    // Re-checked at send time with the record-time consent inputs: the contact may have
    // opted out or been blocked, or the template may have become MARKETING, during the delay.
    const refusal = consentRefusal({
      event: event.event, templateCategory: category, marketingConsent: event.marketing_consent,
      contact: { ...contact, createdNow: event.created_contact_id !== null && event.created_contact_id === contact.id },
    });
    if (refusal) return { kind: 'skip', reason: refusal };
    let config;
    try {
      config = await getNumberConfig(tx, accountId, rule.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) return { kind: 'fail', reason: 'number_unavailable' };
      throw error;
    }
    if (isNumberDisconnected(config)) return { kind: 'fail', reason: 'number_unavailable' };
    const digits = normalizePhone(contact.phone ?? '');
    if (!digits) return { kind: 'skip', reason: 'no_phone' };
    return { kind: 'send', event, rule, contactPhone: `+${digits}`, configId: config.id, wabaId: config.waba_id ?? null };
  }, getWorkerPrisma());

  if (plan.kind === 'noop') return;
  if (plan.kind === 'settled') {
    await settle(accountId, eventId, plan.status, plan.reason);
    // Same as a first ambiguous attempt: the job fails and an admin reconciles.
    if (plan.reason === 'outcome_unknown') throw new UncertainDispatchError();
    return;
  }
  if (plan.kind !== 'send') return settle(accountId, eventId, plan.kind === 'skip' ? 'skipped' : 'failed', plan.reason);

  const { event, rule } = plan;
  const db = createAdminClient({ accountId, role: 'owner' });
  // Refusals Meta would never see are decided here, before an outbound intent exists,
  // so they are recorded as failures instead of ambiguous outcomes.
  const template = await resolveTemplateRow(db, accountId, rule.template_name, rule.template_language);
  if (!template.row) return settle(accountId, eventId, 'failed', 'template_not_found');
  try {
    if (templateSendRefusal(template.row, 'automation') || automationTemplateRefusal(template.row))
      return settle(accountId, eventId, 'failed', 'template_refused');
    assertTemplateOnNumber(template.row, { waba_id: plan.wabaId });
  } catch {
    return settle(accountId, eventId, 'failed', 'template_refused');
  }
  const { conversationId, contactId } = await resolveConversationByPhone(db, accountId, plan.contactPhone, null, { whatsappConfigId: plan.configId });
  if (await botRepliesPaused(accountId, conversationId)) return settle(accountId, eventId, 'skipped', 'bot_paused');
  const userId = await resolveAuditUserId(db, accountId);

  try {
    await dispatchOnce(accountId, `commerce:${eventId}`, () => engineSendTemplate({
      accountId,
      userId,
      conversationId,
      contactId,
      templateName: rule.template_name,
      language: template.language,
      params: resolveTemplateVariables(rule.variable_map, event.payload ?? {}),
      bodyValuesOnly: true,
    }));
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      // Stays 'scheduled' with a reason the UI surfaces for reconciliation; never re-sent.
      await settle(accountId, eventId, 'scheduled', 'outcome_unknown');
      throw error;
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500)
      return settle(accountId, eventId, 'failed', 'provider_rejected');
    throw error;
  }
  await settle(accountId, eventId, 'sent', null);
}
