import type { CommerceEventName, RecordCommerceEventInput } from '@/lib/commerce/event-rules';
import { isCurrencyCode, parseMoney } from '@/lib/commerce/money';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

/**
 * WooCommerce order webhook → commerce events. Pure: no I/O.
 *
 * Topics: order.created and order.updated (others are acknowledged and ignored).
 *  - order.created                          → order_created
 *  - status processing with a paid date     → order_paid
 *    (cash on delivery orders also sit in "processing" but have no paid date,
 *    so they do not claim to be paid)
 *  - status completed                       → order_fulfilled
 *  - status cancelled                       → order_cancelled
 * One webhook can yield two events (an order created already paid). Each event
 * is deduplicated per store + order + event, so the many order.updated
 * deliveries WooCommerce sends for one order produce each message at most once.
 */

export const WOO_TOPICS = ['order.created', 'order.updated'] as const;
export type WooTopic = (typeof WOO_TOPICS)[number];

export function isWooTopic(value: unknown): value is WooTopic {
  return typeof value === 'string' && (WOO_TOPICS as readonly string[]).includes(value);
}

/** The order fields we read. Everything else in the webhook body is ignored. */
export interface WooOrder {
  id: string;
  number: string;
  status: string;
  currency: string;
  total: string;
  datePaid: string | null;
  itemCount: number;
  paymentMethodTitle: string;
  paymentUrl: string | null;
  billing: { firstName: string; lastName: string; phone: string; email: string; country: string };
  shippingPhone: string;
  meta: { key: string; value: unknown }[];
}

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Reads an order from a webhook body (REST v3 shape, or the legacy `{ order: {...} }` wrapper). */
export function parseWooOrder(body: unknown): WooOrder | null {
  const root = obj(body);
  const o = root.order && typeof root.order === 'object' ? obj(root.order) : root;
  const id = str(o.id, 40);
  if (!/^\d{1,20}$/.test(id)) return null;
  const billing = obj(o.billing ?? o.billing_address);
  const shipping = obj(o.shipping ?? o.shipping_address);
  const items = Array.isArray(o.line_items) ? o.line_items.slice(0, 500) : [];
  const itemCount = items.reduce<number>((n, item) => {
    const q = Number(obj(item).quantity);
    return n + (Number.isSafeInteger(q) && q > 0 ? q : 0);
  }, 0);
  const paymentUrl = str(o.payment_url, 1000);
  const meta = (Array.isArray(o.meta_data) ? o.meta_data.slice(0, 200) : [])
    .map((m) => obj(m))
    .filter((m) => typeof m.key === 'string')
    .map((m) => ({ key: m.key as string, value: m.value }));
  return {
    id,
    number: str(o.number, 40) || id,
    status: str(o.status, 40).toLowerCase(),
    currency: str(o.currency, 3).toUpperCase(),
    total: str(o.total, 40),
    datePaid: str(o.date_paid_gmt ?? o.date_paid ?? o.paid_at, 40) || null,
    itemCount,
    paymentMethodTitle: str(o.payment_method_title, 100),
    paymentUrl: /^https:\/\//i.test(paymentUrl) ? paymentUrl : null,
    billing: {
      firstName: str(billing.first_name, 100),
      lastName: str(billing.last_name, 100),
      phone: str(billing.phone, 40),
      email: str(billing.email, 254),
      country: str(billing.country, 2).toUpperCase(),
    },
    shippingPhone: str(shipping.phone, 40),
    meta,
  };
}

/** The commerce events a delivery represents, in send order. */
export function wooOrderEvents(topic: WooTopic, order: Pick<WooOrder, 'status' | 'datePaid'>): CommerceEventName[] {
  const events: CommerceEventName[] = [];
  if (topic === 'order.created') events.push('order_created');
  if (order.status === 'processing' && order.datePaid) events.push('order_paid');
  else if (order.status === 'completed') events.push('order_fulfilled');
  else if (order.status === 'cancelled') events.push('order_cancelled');
  return events;
}

/** Country calling codes for turning a store's national-format phone into international. */
const CALLING_CODES: Record<string, string> = {
  IN: '91', US: '1', CA: '1', GB: '44', IE: '353', AU: '61', NZ: '64', SG: '65', MY: '60', ID: '62', PH: '63', TH: '66',
  VN: '84', HK: '852', JP: '81', KR: '82', CN: '86', TW: '886', AE: '971', SA: '966', QA: '974', KW: '965', BH: '973',
  OM: '968', EG: '20', ZA: '27', NG: '234', KE: '254', GH: '233', PK: '92', BD: '880', LK: '94', NP: '977', TR: '90',
  DE: '49', FR: '33', ES: '34', PT: '351', IT: '39', NL: '31', BE: '32', CH: '41', AT: '43', SE: '46', NO: '47',
  DK: '45', FI: '358', PL: '48', CZ: '420', RO: '40', GR: '30', IL: '972', BR: '55', MX: '52', AR: '54', CL: '56',
  CO: '57', PE: '51',
};

/**
 * A WhatsApp-ready "+<digits>" phone, or null. Accepts "+…" and "00…"
 * international forms anywhere; a national number is completed with the
 * billing country's calling code (a leading trunk 0 is dropped, except for
 * Italy where it is part of the number). Without a known country a national
 * number is refused rather than guessed.
 */
export function wooPhoneToInternational(raw: string, country: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (!compact) return null;
  if (compact.startsWith('+')) return parseInternationalPhone(compact) ? compact : null;
  if (!/^\d{4,20}$/.test(compact)) return null;
  if (compact.startsWith('00')) {
    const intl = `+${compact.slice(2)}`;
    return parseInternationalPhone(intl) ? intl : null;
  }
  const code = CALLING_CODES[country];
  if (!code) return null;
  let national = compact;
  if (national.startsWith(code) && national.length > 10) national = national.slice(code.length);
  else if (country !== 'IT') national = national.replace(/^0+/, '');
  const intl = `+${code}${national}`;
  return parseInternationalPhone(intl) ? intl : null;
}

const YES = new Set(['yes', 'y', 'true', '1', 'on', 'opt-in', 'opted_in', 'subscribed']);
const NO = new Set(['no', 'n', 'false', '0', 'off', '', 'opt-out', 'opted_out', 'unsubscribed']);

/**
 * The store's marketing consent from the configured order meta key: true, false,
 * or null when no key is configured or the order does not carry it. Null means
 * marketing templates only reach an existing, not-opted-out contact.
 */
export function wooMarketingConsent(meta: WooOrder['meta'], consentMetaKey: string | null): boolean | null {
  if (!consentMetaKey) return null;
  const entry = meta.find((m) => m.key === consentMetaKey);
  if (!entry) return null;
  const v = entry.value;
  if (typeof v === 'boolean') return v;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().toLowerCase() : null;
  if (s === null) return null;
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return null;
}

/** Minimised template fields (no address, email or line items). */
export function wooEventPayload(order: WooOrder, storeUrl: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    order_id: order.id,
    order_number: order.number,
    order_status: order.status,
    item_count: order.itemCount,
    store_url: storeUrl,
  };
  if (isCurrencyCode(order.currency)) {
    payload.currency = order.currency;
    try {
      // Trailing zeros past the currency's decimals ("1000.00" JPY) carry no value.
      const total = order.total.includes('.') ? order.total.replace(/0+$/, '').replace(/\.$/, '') : order.total;
      payload.total_minor = parseMoney(total, order.currency);
    } catch {
      // A total we cannot read exactly is left out rather than approximated.
    }
  }
  if (order.paymentMethodTitle) payload.payment_method = order.paymentMethodTitle;
  if (order.paymentUrl) payload.payment_url = order.paymentUrl;
  return payload;
}

/** Store-scoped, delivery-independent key: one message per order per event. */
export function wooEventDedupeKey(storeId: string, orderId: string, event: CommerceEventName): string {
  return `woocommerce:${storeId}:${orderId}:${event}`;
}

/** The recordCommerceEvent inputs for one verified delivery (empty when nothing applies). */
export function buildWooCommerceInputs(input: {
  accountId: string;
  storeId: string;
  storeUrl: string;
  consentMetaKey: string | null;
  topic: WooTopic;
  order: WooOrder;
}): RecordCommerceEventInput[] {
  const { order } = input;
  const events = wooOrderEvents(input.topic, order);
  if (!events.length) return [];
  const phone =
    wooPhoneToInternational(order.billing.phone, order.billing.country) ??
    wooPhoneToInternational(order.shippingPhone, order.billing.country);
  const name = `${order.billing.firstName} ${order.billing.lastName}`.trim() || null;
  const payload = wooEventPayload(order, input.storeUrl);
  const marketingConsent = wooMarketingConsent(order.meta, input.consentMetaKey);
  return events.map((event) => ({
    accountId: input.accountId,
    source: 'woocommerce' as const,
    event,
    externalId: order.id,
    dedupeKey: wooEventDedupeKey(input.storeId, order.id, event),
    payload,
    phone,
    name,
    email: order.billing.email || null,
    marketingConsent,
  }));
}
