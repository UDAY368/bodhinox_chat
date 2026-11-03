/**
 * Orders without the database: statuses and the transitions agents may make,
 * the parser for a WhatsApp cart (Meta's inbound `order` message), the text
 * the inbox and flows show for it, and the flow variables it sets.
 *
 * Client-safe (no server imports): the inbox bubble and the orders pages use it.
 * Amounts are integer minor units (see ./money).
 */

import { formatMoney, isCurrencyCode, MAX_MINOR, MoneyError, parseMoney } from './money';

export const ORDER_STATUSES = [
  'new', 'confirmed', 'awaiting_payment', 'payment_review', 'paid', 'dispatched', 'fulfilled', 'expired', 'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_SOURCES = ['whatsapp', 'shopify', 'woocommerce', 'manual', 'storefront'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];
export const REFUND_STATES = ['none', 'partial', 'full'] as const;
export type RefundState = (typeof REFUND_STATES)[number];

/**
 * Statuses only the worker sets, after a verified payment, a reservation
 * expiry or a payment exception (the orders_status_guard trigger refuses them
 * for a browser session). Staff never mark an order paid by hand: a payment
 * taken outside a link is recorded through "Record offline payment".
 */
export const WORKER_ONLY_STATUSES: readonly OrderStatus[] = ['paid', 'payment_review', 'expired'];

/**
 * Status changes staff may make. `fulfilled` is shown as "Delivered (staff
 * recorded)". paid -> cancelled goes through "Cancel and refund" only.
 * Final for staff: fulfilled, cancelled, expired, payment_review (resolved
 * through the payment exceptions queue).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ['confirmed', 'awaiting_payment', 'cancelled'],
  confirmed: ['awaiting_payment', 'fulfilled', 'cancelled'],
  awaiting_payment: ['cancelled'],
  payment_review: [],
  paid: ['dispatched', 'cancelled'],
  dispatched: ['fulfilled'],
  fulfilled: [],
  expired: [],
  cancelled: [],
};

/** Moves allowed only for legacy unpriced orders (a priced order is paid before it is fulfilled). */
const UNPRICED_ONLY: ReadonlySet<string> = new Set(['new>awaiting_payment', 'confirmed>awaiting_payment', 'confirmed>fulfilled']);

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isOrderSource(value: unknown): value is OrderSource {
  return typeof value === 'string' && (ORDER_SOURCES as readonly string[]).includes(value);
}

/** May staff move an order from `from` to `to`? `priced` = the order has server-priced snapshots (priced_at set). */
export function canTransition(from: OrderStatus, to: OrderStatus, opts: { priced?: boolean } = {}): boolean {
  if (!ORDER_TRANSITIONS[from].includes(to)) return false;
  return !(opts.priced && UNPRICED_ONLY.has(`${from}>${to}`));
}

/** Statuses staff can pick next for an order (the order detail selector). */
export function nextStatuses(from: OrderStatus, opts: { priced?: boolean } = {}): OrderStatus[] {
  return ORDER_TRANSITIONS[from].filter((to) => canTransition(from, to, opts));
}

export const ORDER_LIMITS = { maxItems: 100, maxQuantity: 100_000, noteMaxLength: 2000, retailerIdMaxLength: 200 } as const;

export interface InboundOrderItem {
  retailer_id: string;
  /** The product's name from the synced catalogue, when known. */
  name: string | null;
  quantity: number;
  unit_price_minor: number;
}

/** A WhatsApp cart as parsed from the webhook (names filled in later from the catalogue). */
export interface InboundOrder {
  catalog_id: string | null;
  currency: string;
  subtotal_minor: number;
  items: InboundOrderItem[];
  /** The text the customer sent with the cart. */
  note: string | null;
}

/** What messages.interactive_payload.order holds for an inbound cart. */
export interface OrderMessagePayload extends InboundOrder {
  order_id: string;
}

const isRetailerId = (v: string) => v.length >= 1 && v.length <= ORDER_LIMITS.retailerIdMaxLength &&
  [...v].every((c) => c.charCodeAt(0) >= 32);

function quantityOf(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 1 && n <= ORDER_LIMITS.maxQuantity ? n : null;
}

/** Meta sends a major-unit price ("100", 99.9, "250.00"); trailing zeros past the currency's decimals are allowed. */
function priceMinor(value: unknown, currency: string): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  let text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  try {
    return parseMoney(text, currency);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * Parse Meta's `order` object ({ catalog_id, text, product_items: [{
 * product_retailer_id, quantity, item_price, currency }] }). Returns null for
 * anything that cannot be stored exactly: no items, too many, a bad quantity or
 * price, or items in different currencies.
 */
export function parseInboundOrder(raw: unknown): InboundOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const order = raw as { catalog_id?: unknown; text?: unknown; product_items?: unknown };
  if (!Array.isArray(order.product_items) || order.product_items.length === 0 ||
    order.product_items.length > ORDER_LIMITS.maxItems) return null;
  let currency: string | null = null;
  let subtotal = BigInt(0);
  const items: InboundOrderItem[] = [];
  for (const entry of order.product_items as unknown[]) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    const code = typeof item.currency === 'string' ? item.currency.trim().toUpperCase() : '';
    if (!isCurrencyCode(code) || (currency !== null && code !== currency)) return null;
    currency = code;
    const retailerId = typeof item.product_retailer_id === 'string' ? item.product_retailer_id.trim() : '';
    if (!isRetailerId(retailerId)) return null;
    const quantity = quantityOf(item.quantity);
    const unit = priceMinor(item.item_price, code);
    if (quantity === null || unit === null) return null;
    subtotal += BigInt(unit) * BigInt(quantity);
    items.push({ retailer_id: retailerId, name: null, quantity, unit_price_minor: unit });
  }
  if (currency === null || subtotal > BigInt(MAX_MINOR)) return null;
  const catalogId = typeof order.catalog_id === 'string' && /^\d{1,32}$/.test(order.catalog_id) ? order.catalog_id : null;
  const note = typeof order.text === 'string' && order.text.trim() ? order.text.trim().slice(0, ORDER_LIMITS.noteMaxLength) : null;
  return { catalog_id: catalogId, currency, subtotal_minor: Number(subtotal), items, note };
}

/** Total number of units in the cart (2 shirts + 1 cap = 3). */
export function orderUnitCount(items: Pick<InboundOrderItem, 'quantity'>[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

/** "2 × Blue shirt, 1 × Cap", at most `max` characters. */
export function orderItemsSummary(items: Pick<InboundOrderItem, 'quantity' | 'name' | 'retailer_id'>[], max = 500): string {
  const text = items.map((item) => `${item.quantity} × ${item.name || item.retailer_id}`).join(', ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The inbox text for a cart (messages.content_text and the conversation preview). */
export function orderContentText(order: InboundOrder): string {
  return `[Order] ${orderItemsSummary(order.items, 800)} — ${formatMoney(order.subtotal_minor, order.currency)}`;
}

/** Variables an order_received flow starts with. */
export function orderFlowVars(order: OrderMessagePayload): Record<string, string> {
  return {
    order_id: order.order_id,
    order_total: formatMoney(order.subtotal_minor, order.currency),
    order_total_minor: String(order.subtotal_minor),
    order_currency: order.currency,
    order_items_count: String(orderUnitCount(order.items)),
    order_items: orderItemsSummary(order.items),
  };
}

/** Narrow a stored interactive_payload.order (written by the inbound pipeline) before use. */
export function asOrderMessagePayload(value: unknown): OrderMessagePayload | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Partial<OrderMessagePayload>;
  if (typeof o.order_id !== 'string' || !isCurrencyCode(o.currency) || !Number.isSafeInteger(o.subtotal_minor) ||
    !Array.isArray(o.items)) return null;
  const items = o.items.filter((i): i is InboundOrderItem => Boolean(i) && typeof i.retailer_id === 'string' &&
    Number.isSafeInteger(i.quantity) && Number.isSafeInteger(i.unit_price_minor));
  return {
    order_id: o.order_id, currency: o.currency, subtotal_minor: o.subtotal_minor as number, items,
    catalog_id: typeof o.catalog_id === 'string' ? o.catalog_id : null,
    note: typeof o.note === 'string' ? o.note : null,
  };
}

/** Placeholders an order confirmation text may use, written {{name}}. */
export const ORDER_CONFIRMATION_FIELDS = ['customer_name', 'order_id', 'order_total', 'order_currency', 'order_items_count', 'order_items'] as const;

/** Fill {{field}} placeholders; unknown ones are left as typed. */
export function fillOrderPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}
