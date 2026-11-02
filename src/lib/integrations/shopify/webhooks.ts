import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import {
  recordCommerceEvent, type CommerceEventName, type RecordCommerceEventInput, type RecordCommerceEventResult,
} from '@/lib/commerce/event-rules';
import { claimWebhookReceipt, markWebhookReceiptProcessed } from '@/lib/commerce/webhook-receipts';
import { MoneyError, isCurrencyCode, parseMoney } from '@/lib/commerce/money';
import { emitOrderCreated, emitOrderPaid } from '@/lib/webhooks/commerce-events';
import { isShopDomain } from './oauth';
import { resolveShopifyStores, stopShopifyStore } from './store';

/**
 * Shopify webhooks → commerce events.
 *
 * The route verifies X-Shopify-Hmac-Sha256 over the raw body, then calls
 * processShopifyWebhook, which records everything in one worker transaction per
 * workspace: the delivery receipt (keyed by X-Shopify-Webhook-Id, so a
 * redelivery is a no-op), the commerce event and its queued send. Only then
 * does the route answer 200. A failure rolls everything back and Shopify
 * retries.
 *
 * Outbound webhooks: a newly recorded orders/create or orders/paid event emits
 * `order.created` / `order.paid` once, after the transaction commits. A
 * redelivery (same webhook id) or a repeat of the same order event (same
 * dedupe key) records nothing new and emits nothing.
 *
 * Abandoned checkouts: checkouts/create and checkouts/update record one
 * `checkout_abandoned` event per checkout token, once the checkout carries a
 * phone number. The rule's delay schedules the send; the send job skips it if
 * an order event with the same checkout_token arrived meanwhile.
 */

export const GDPR_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
const EVENT_TOPICS: Record<string, CommerceEventName> = {
  'orders/create': 'order_created',
  'orders/paid': 'order_paid',
  'orders/fulfilled': 'order_fulfilled',
  'orders/cancelled': 'order_cancelled',
  'checkouts/create': 'checkout_abandoned',
  'checkouts/update': 'checkout_abandoned',
};
export const SUPPORTED_TOPICS = [...Object.keys(EVENT_TOPICS), 'app/uninstalled', ...GDPR_TOPICS];

/**
 * Event fields a rule can map into template variables. `total`/`subtotal` are
 * the formatted amounts recordCommerceEvent derives from the *_minor fields.
 */
export const SHOPIFY_TEMPLATE_FIELDS = [
  'customer_first_name', 'customer_name', 'order_number', 'total', 'subtotal', 'currency', 'item_count',
  'status_url', 'tracking_url', 'tracking_number', 'carrier', 'checkout_url', 'cancel_reason', 'financial_status',
  'fulfillment_status', 'shop_domain',
] as const;

export function mapTopic(topic: string): CommerceEventName | null {
  return Object.prototype.hasOwnProperty.call(EVENT_TOPICS, topic) ? EVENT_TOPICS[topic] : null;
}

/** Base64 HMAC-SHA256 of the raw body with the app secret, compared in constant time. */
export function verifyWebhookHmac(rawBody: string | Buffer, header: string | null | undefined, secret: string): boolean {
  if (!header || header.length > 128 || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

// ---------------------------------------------------------------------------
// Payload mapping (pure)

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown, max = 1000): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Stable key for matching a customer's events on redaction without storing the email. */
export function customerEmailKey(shop: string, email: string | null | undefined): string | null {
  const clean = email?.trim().toLowerCase();
  return clean ? sha(`${shop}\n${clean}`) : null;
}

function consentState(value: unknown): boolean | null {
  const state = str(obj(value)?.state)?.toLowerCase();
  if (state === 'subscribed') return true;
  if (state === 'not_subscribed' || state === 'unsubscribed' || state === 'redacted' || state === 'invalid') return false;
  return null;
}

/**
 * The store's marketing consent for this customer: SMS consent first (closest to
 * WhatsApp), then email consent, then the legacy accepts_marketing flags.
 * Null when the store reports nothing.
 */
export function shopifyMarketingConsent(body: Json): boolean | null {
  const customer = obj(body.customer);
  const sms = consentState(customer?.sms_marketing_consent ?? body.sms_marketing_consent);
  if (sms !== null) return sms;
  const email = consentState(customer?.email_marketing_consent ?? body.email_marketing_consent);
  if (email !== null) return email;
  for (const flag of [customer?.accepts_marketing, body.buyer_accepts_marketing, body.accepts_marketing])
    if (typeof flag === 'boolean') return flag;
  return null;
}

function firstPhone(body: Json): string | null {
  const customer = obj(body.customer);
  const candidates = [
    body.phone, customer?.phone, obj(body.shipping_address)?.phone, obj(body.billing_address)?.phone, obj(customer?.default_address)?.phone,
  ].map((v) => str(v, 40)).filter((v): v is string => !!v);
  // Prefer an international number; a local one cannot be dialled without the country.
  return candidates.find((p) => p.startsWith('+')) ?? candidates[0] ?? null;
}

function minor(value: unknown, currency: string): number | undefined {
  const text = str(value, 40);
  if (!text) return undefined;
  try {
    return parseMoney(text, currency);
  } catch (error) {
    if (error instanceof MoneyError) return undefined;
    throw error;
  }
}

function itemCount(body: Json): number | undefined {
  if (!Array.isArray(body.line_items)) return undefined;
  return body.line_items.reduce<number>((sum, item) => {
    const qty = Number(obj(item)?.quantity);
    return sum + (Number.isSafeInteger(qty) && qty > 0 ? qty : 0);
  }, 0);
}

function latestFulfillment(body: Json): Json | null {
  const list = Array.isArray(body.fulfillments) ? body.fulfillments.map(obj).filter((f): f is Json => !!f) : [];
  return list.length ? list[list.length - 1] : null;
}

function dedupe(shop: string, event: string, id: string): string {
  const key = `shopify:${shop}:${event}:${id}`;
  return key.length <= 300 ? key : `shopify:${sha(key)}`;
}

export type ShopifyEventInput = Omit<RecordCommerceEventInput, 'accountId'>;

/**
 * Maps a Shopify order or checkout webhook to a commerce event, or null when
 * nothing should be recorded (unknown topic, missing id, a checkout that is
 * already completed or has no phone yet). Only template-safe fields are kept.
 */
export function mapShopifyEvent(topic: string, body: Json, shop: string, opts: { marketingOptInOnly: boolean }): ShopifyEventInput | null {
  const event = mapTopic(topic);
  if (!event) return null;
  const customer = obj(body.customer);
  const currencyRaw = str(body.currency ?? body.presentment_currency, 10)?.toUpperCase() ?? '';
  const currency = isCurrencyCode(currencyRaw) ? currencyRaw : null;
  const billing = obj(body.billing_address), shipping = obj(body.shipping_address);
  const firstName = str(customer?.first_name, 200) ?? str(billing?.first_name, 200) ?? str(shipping?.first_name, 200);
  const lastName = str(customer?.last_name, 200) ?? str(billing?.last_name, 200) ?? str(shipping?.last_name, 200);
  const name = [firstName, lastName].filter(Boolean).join(' ') || null;
  const email = str(body.email ?? body.contact_email ?? customer?.email, 320);
  const consent = shopifyMarketingConsent(body);

  const payload: Json = {
    shop_domain: shop,
    customer_first_name: firstName,
    customer_id: str(customer?.id, 40),
    customer_email_key: customerEmailKey(shop, email),
    currency,
    item_count: itemCount(body),
  };
  if (currency) {
    payload.total_minor = minor(body.total_price, currency);
    payload.subtotal_minor = minor(body.subtotal_price, currency);
  }

  let externalId: string | null;
  let dedupeKey: string;
  if (event === 'checkout_abandoned') {
    const token = str(body.token, 200);
    if (!token || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) return null;
    if (body.completed_at) return null;
    externalId = token;
    payload.checkout_token = token;
    payload.checkout_url = str(body.abandoned_checkout_url, 1000);
    dedupeKey = dedupe(shop, event, token);
  } else {
    const id = str(body.id, 40);
    if (!id || !/^\d{1,40}$/.test(id)) return null;
    externalId = id;
    const fulfillment = latestFulfillment(body);
    const trackingUrls = Array.isArray(fulfillment?.tracking_urls) ? fulfillment.tracking_urls : [];
    Object.assign(payload, {
      order_id: id,
      order_number: str(body.name, 64) ?? str(body.order_number, 64),
      status_url: str(body.order_status_url, 1000),
      checkout_token: str(body.checkout_token, 200),
      financial_status: str(body.financial_status, 40),
      fulfillment_status: str(body.fulfillment_status, 40),
      cancel_reason: event === 'order_cancelled' ? str(body.cancel_reason, 40) : null,
      tracking_url: str(fulfillment?.tracking_url, 1000) ?? str(trackingUrls[0], 1000),
      tracking_number: str(fulfillment?.tracking_number, 100),
      carrier: str(fulfillment?.tracking_company, 100),
    });
    dedupeKey = dedupe(shop, event, id);
  }
  const phone = firstPhone(body);
  if (event === 'checkout_abandoned' && !phone) return null;

  for (const key of Object.keys(payload)) if (payload[key] === null || payload[key] === undefined) delete payload[key];
  return {
    source: 'shopify',
    event,
    externalId,
    dedupeKey,
    payload,
    phone,
    name,
    email,
    // Opt-in only: unknown consent counts as no for marketing.
    marketingConsent: opts.marketingOptInOnly ? consent === true : consent,
  };
}

// ---------------------------------------------------------------------------
// Processing

export type ShopifyWebhookOutcome =
  | 'recorded' | 'duplicate' | 'ignored' | 'uninstalled' | 'data_request_recorded' | 'redacted';

export interface ShopifyDelivery {
  topic: string;
  shop: string;
  webhookId: string;
  /** X-Shopify-Triggered-At, when sent. */
  triggeredAt?: Date | null;
  body: Json;
}

const worker = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

/** Claims the delivery receipt for one workspace; returns null when it was already processed. */
async function claim(tx: TenantTransaction, delivery: ShopifyDelivery, accountId: string, payload: Json): Promise<string | null> {
  const receipt = await claimWebhookReceipt(tx, {
    provider: 'shopify',
    receiptId: `${delivery.webhookId}:${accountId}`,
    payload: { topic: delivery.topic, shop: delivery.shop, ...payload },
  });
  return receipt.duplicate ? null : receipt.id;
}

const idList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => str(v, 40)).filter((v): v is string => !!v && /^\d{1,40}$/.test(v)).slice(0, 5000) : [];

const REDACTED = JSON.stringify({ redacted: true });

/**
 * Erases contacts that redacted store events created (commerce_events.created_contact_id).
 * A contact with no conversation and no remaining order or store-event link
 * exists only because of the store, so it is deleted. One the workspace has
 * since talked to (or that another order still names) keeps its phone, its
 * WhatsApp identity, but loses the store-supplied name and email. Contacts the
 * workspace already had are never in `contactIds`. Returns the number deleted.
 */
async function eraseStoreCreatedContacts(tx: TenantTransaction, accountId: string, contactIds: string[]): Promise<number> {
  if (!contactIds.length) return 0;
  const deleted = await tx.$executeRaw`
    DELETE FROM contacts c
    WHERE c.account_id=${accountId}::uuid AND c.id = ANY(${contactIds}::uuid[])
      AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.account_id=c.account_id AND v.contact_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.account_id=c.account_id AND o.contact_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM commerce_events e WHERE e.account_id=c.account_id AND (e.contact_id=c.id OR e.created_contact_id=c.id))`;
  await tx.$executeRaw`
    UPDATE contacts SET name=phone, email=NULL
    WHERE account_id=${accountId}::uuid AND id = ANY(${contactIds}::uuid[])`;
  return deleted;
}

/** Anonymises the given events (payload, contact links, pending send) and erases the contacts they created. */
async function redactEvents(tx: TenantTransaction, accountId: string, eventIds: string[]): Promise<number> {
  if (!eventIds.length) return 0;
  const created = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT created_contact_id::text AS id FROM commerce_events
    WHERE account_id=${accountId}::uuid AND id = ANY(${eventIds}::uuid[]) AND created_contact_id IS NOT NULL`;
  const changed = await tx.$executeRaw`
    UPDATE commerce_events SET payload=${REDACTED}::jsonb, contact_id=NULL, created_contact_id=NULL,
      status=CASE WHEN status='scheduled' AND reason IS NULL THEN 'skipped' ELSE status END,
      reason=CASE WHEN status='scheduled' AND reason IS NULL THEN 'customer_redacted' ELSE reason END
    WHERE account_id=${accountId}::uuid AND id = ANY(${eventIds}::uuid[])`;
  await eraseStoreCreatedContacts(tx, accountId, created.map((r) => r.id));
  return changed;
}

/**
 * Anonymises a customer's Shopify events (and store orders) in one workspace
 * and erases the contacts those events created. Returns the number of events changed.
 */
export async function redactShopifyCustomer(
  tx: TenantTransaction, accountId: string, shop: string, input: { customerId: string | null; emailKey: string | null; orderIds: string[] },
): Promise<number> {
  const customerId = input.customerId ?? '';
  const emailKey = input.emailKey ?? '';
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM commerce_events
    WHERE account_id=${accountId}::uuid AND source='shopify' AND payload->>'shop_domain'=${shop}
      AND ((${customerId}<>'' AND payload->>'customer_id'=${customerId})
        OR (${emailKey}<>'' AND payload->>'customer_email_key'=${emailKey})
        OR (event<>'checkout_abandoned' AND external_id = ANY(${input.orderIds}::text[])))
    FOR UPDATE`;
  const changed = await redactEvents(tx, accountId, rows.map((r) => r.id));
  if (input.orderIds.length) {
    await tx.$executeRaw`
      UPDATE orders SET contact_id=NULL, conversation_id=NULL, customer_note=NULL
      WHERE account_id=${accountId}::uuid AND source='shopify' AND external_id = ANY(${input.orderIds}::text[])`;
  }
  return changed;
}

/**
 * Anonymises every event of `shop` in one workspace, erases the contacts they
 * created and removes the uninstalled store row (shop/redact).
 */
export async function redactShopifyShop(tx: TenantTransaction, accountId: string, shop: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM commerce_events
    WHERE account_id=${accountId}::uuid AND source='shopify' AND payload->>'shop_domain'=${shop}
    FOR UPDATE`;
  const changed = await redactEvents(tx, accountId, rows.map((r) => r.id));
  await tx.$executeRaw`DELETE FROM shopify_stores WHERE account_id=${accountId}::uuid AND shop_domain=${shop} AND uninstalled_at IS NOT NULL`;
  return changed;
}

/**
 * The outbound `order.created` / `order.paid` webhook for a newly recorded
 * Shopify order event. Call only after the recording transaction committed.
 * Nothing for a duplicate (same dedupe key) or another event. Never throws.
 */
export async function emitShopifyOrderWebhook(
  accountId: string, input: ShopifyEventInput, result: Pick<RecordCommerceEventResult, 'duplicate' | 'contactId'>,
): Promise<boolean> {
  if (result.duplicate) return false;
  const emit = input.event === 'order_created' ? emitOrderCreated : input.event === 'order_paid' ? emitOrderPaid : null;
  if (!emit) return false;
  const p = input.payload;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  try {
    return await emit(accountId, {
      source: 'shopify',
      externalId: input.externalId ?? null,
      orderNumber: text(p.order_number),
      status: text(p.financial_status),
      totalMinor: num(p.total_minor),
      currency: text(p.currency),
      itemCount: num(p.item_count),
      contactId: result.contactId,
      customerName: input.name ?? null,
      customerPhone: input.phone ?? null,
    });
  } catch {
    return false;
  }
}

/**
 * Applies one verified delivery. Throws on a database failure (the route then
 * answers 503 and Shopify redelivers); every other case resolves.
 */
export async function processShopifyWebhook(delivery: ShopifyDelivery): Promise<ShopifyWebhookOutcome> {
  const { topic, shop, body } = delivery;
  if (!isShopDomain(shop) || !SUPPORTED_TOPICS.includes(topic)) return 'ignored';
  const stores = await resolveShopifyStores(shop);
  const active = stores.find((s) => s.active) ?? null;

  if (mapTopic(topic)) {
    if (!active) return 'ignored';
    type Done = { outcome: ShopifyWebhookOutcome; recorded?: { input: ShopifyEventInput; result: RecordCommerceEventResult } };
    const done = await worker(active.account_id, async (tx): Promise<Done> => {
      const [store] = await tx.$queryRaw<{ marketing_opt_in_only: boolean }[]>`
        SELECT marketing_opt_in_only FROM shopify_stores
        WHERE account_id=${active.account_id}::uuid AND id=${active.store_id}::uuid AND uninstalled_at IS NULL FOR SHARE`;
      if (!store) return { outcome: 'ignored' };
      const input = mapShopifyEvent(topic, body, shop, { marketingOptInOnly: store.marketing_opt_in_only });
      const receiptId = await claim(tx, delivery, active.account_id, input ? { event: input.event, external_id: input.externalId } : { skipped: true });
      if (!receiptId) return { outcome: 'duplicate' };
      if (!input) {
        await markWebhookReceiptProcessed(tx, receiptId);
        return { outcome: 'ignored' };
      }
      const result = await recordCommerceEvent(tx, { accountId: active.account_id, ...input });
      await markWebhookReceiptProcessed(tx, receiptId);
      return { outcome: 'recorded', recorded: { input, result } };
    });
    // Committed. Best effort: a webhook problem never undoes or retries the recorded event.
    if (done.recorded) await emitShopifyOrderWebhook(active.account_id, done.recorded.input, done.recorded.result);
    return done.outcome;
  }

  if (topic === 'app/uninstalled') {
    if (!active) return 'ignored';
    return worker(active.account_id, async (tx) => {
      const receiptId = await claim(tx, delivery, active.account_id, {});
      if (!receiptId) return 'duplicate';
      await stopShopifyStore(tx, active.account_id, { before: delivery.triggeredAt ?? null });
      await markWebhookReceiptProcessed(tx, receiptId);
      return 'uninstalled';
    });
  }

  if (topic === 'customers/data_request') {
    // Recorded for the workspace owner to answer; the store owner gets the export from support.
    const customer = obj(body.customer);
    let outcome: ShopifyWebhookOutcome = 'ignored';
    for (const store of stores) {
      outcome = await worker(store.account_id, async (tx) => {
        const customerId = str(customer?.id, 40) ?? '';
        const emailKey = customerEmailKey(shop, str(customer?.email, 320)) ?? '';
        const [held] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM commerce_events
          WHERE account_id=${store.account_id}::uuid AND source='shopify' AND payload->>'shop_domain'=${shop}
            AND ((${customerId}<>'' AND payload->>'customer_id'=${customerId}) OR (${emailKey}<>'' AND payload->>'customer_email_key'=${emailKey}))`;
        const receiptId = await claim(tx, delivery, store.account_id, {
          customer_id: customerId || null,
          data_request_id: str(obj(body.data_request)?.id, 40),
          orders_requested: idList(body.orders_requested).length,
          events_held: held?.n ?? 0,
        });
        return receiptId ? 'data_request_recorded' : 'duplicate';
      });
    }
    return outcome;
  }

  if (topic === 'customers/redact') {
    const customer = obj(body.customer);
    const input = {
      customerId: str(customer?.id, 40),
      emailKey: customerEmailKey(shop, str(customer?.email, 320)),
      orderIds: idList(body.orders_to_redact),
    };
    let outcome: ShopifyWebhookOutcome = 'ignored';
    for (const store of stores) {
      outcome = await worker(store.account_id, async (tx) => {
        const receiptId = await claim(tx, delivery, store.account_id, { orders: input.orderIds.length });
        if (!receiptId) return 'duplicate';
        await redactShopifyCustomer(tx, store.account_id, shop, input);
        await markWebhookReceiptProcessed(tx, receiptId);
        return 'redacted';
      });
    }
    return outcome;
  }

  if (topic === 'shop/redact') {
    let outcome: ShopifyWebhookOutcome = 'ignored';
    // Sent 48 hours after uninstall; a workspace that reinstalled the store meanwhile keeps its data.
    for (const store of stores.filter((s) => !s.active)) {
      outcome = await worker(store.account_id, async (tx) => {
        const receiptId = await claim(tx, delivery, store.account_id, {});
        if (!receiptId) return 'duplicate';
        await redactShopifyShop(tx, store.account_id, shop);
        await markWebhookReceiptProcessed(tx, receiptId);
        return 'redacted';
      });
    }
    return outcome;
  }
  return 'ignored';
}
