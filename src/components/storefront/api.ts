/**
 * Browser helpers for the anonymous storefront APIs. Plain same-origin fetch:
 * no session, no CSRF header (the routes check Origin, which the browser sets
 * on PUT and POST). Errors are code-only.
 */
import type { CataloguePage, StorefrontOrderView, StorefrontProduct, StorefrontView } from '@/lib/commerce/storefront';
import type { Quote } from '@/lib/commerce/pricing';

export type { CataloguePage, StorefrontOrderView, StorefrontProduct, StorefrontView, Quote };

/**
 * The wording version of the repeat-purchase consent checkbox: the message key
 * Storefront.marketingOptIn.<version> and the value placeOrder records as
 * orders.marketing_opt_in_version. A new wording gets a new version.
 */
export { MARKETING_OPT_IN_VERSION } from '@/lib/commerce/marketing-consent';

export class ShopApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(code);
    this.name = 'ShopApiError';
  }
}

/** Codes with their own customer-facing message (Storefront.errors.*); anything else is "error". */
export const SHOP_ERROR_CODES = [
  'not_found', 'too_many', 'forbidden', 'invalid', 'conflict', 'cart_locked', 'session_expired', 'address_required', 'quote_changed',
  'out_of_stock', 'checkout_disabled', 'store_not_configured', 'cart_empty', 'invalid_cart', 'variant_unavailable', 'price_not_configured',
  'tax_not_configured', 'shipping_unavailable', 'coupon_not_found', 'coupon_inactive', 'coupon_not_started', 'coupon_expired',
  'coupon_min_subtotal', 'coupon_exhausted', 'coupon_limit_reached', 'order_not_open', 'amount_out_of_range', 'too_many_open_orders',
  'cod_unavailable', 'online_unavailable', 'delivery_unavailable', 'extras_invalid', 'returns_unavailable', 'return_window_closed',
  'return_line_open', 'return_quantity', 'exchange_unavailable', 'wishlist_full', 'repeat_unavailable', 'error',
] as const;
export type ShopErrorCode = (typeof SHOP_ERROR_CODES)[number];

export function shopErrorCode(error: unknown): ShopErrorCode {
  const code = error instanceof ShopApiError ? error.code : 'error';
  return (SHOP_ERROR_CODES as readonly string[]).includes(code) ? code as ShopErrorCode : 'error';
}

async function call<T>(url: string, method: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<T> {
  const response = await fetch(url, method === 'GET'
    ? { cache: 'no-store' }
    : { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await response.json().catch(() => null) as (T & { code?: string }) | null;
  if (!response.ok || !data) throw new ShopApiError(typeof data?.code === 'string' ? data.code : 'error', response.status, (data ?? {}) as Record<string, unknown>);
  return data;
}

export interface ExtrasValues { note?: string | null; gift_message?: string | null; delivery_date?: string | null; slot_id?: string | null; custom?: Record<string, string | boolean> }
export interface ReturnRequestBody {
  clientRequestId: string;
  reason: string;
  note?: string | null;
  lines: Array<{ order_item_id: string; qty: number; exchange_variant_id?: string | null }>;
}

const base = (token: string) => `/api/public/shop/${encodeURIComponent(token)}`;

export const shopApi = {
  view: (token: string) => call<StorefrontView>(base(token), 'GET'),
  cart: (token: string, expectedVersion: number, lines: Array<{ variantId: string; qty: number }>) =>
    call<StorefrontView>(`${base(token)}/cart`, 'PUT', { expectedVersion, lines }),
  address: (token: string, expectedVersion: number, address: Record<string, string | null> | null) =>
    call<StorefrontView>(`${base(token)}/address`, 'PUT', { expectedVersion, address }),
  coupon: (token: string, expectedVersion: number, code: string | null) =>
    call<StorefrontView>(`${base(token)}/coupon`, 'PUT', { expectedVersion, code }),
  /** How to pay: 'online' (a payment link) or 'cod' (cash on delivery). */
  payment: (token: string, expectedVersion: number, paymentMethod: 'online' | 'cod') =>
    call<StorefrontView>(`${base(token)}/payment`, 'PUT', { expectedVersion, paymentMethod }),
  /** How the order reaches the customer: 'ship' (a shipping rate), 'pickup' (collect at the store) or 'local' (the store's own delivery). */
  delivery: (token: string, expectedVersion: number, deliveryMethod: 'ship' | 'pickup' | 'local') =>
    call<StorefrontView>(`${base(token)}/delivery`, 'PUT', { expectedVersion, deliveryMethod }),
  /** Pay with store credit and with loyalty points: two switches; the server works out how much each pays. */
  tender: (token: string, expectedVersion: number, useStoreCredit: boolean, usePoints: boolean) =>
    call<StorefrontView>(`${base(token)}/tender`, 'PUT', { expectedVersion, useStoreCredit, usePoints }),
  /** What the buyer asks for at checkout (note, gift message, delivery date and slot, custom answers); checked on the server. */
  extras: (token: string, expectedVersion: number, extras: ExtrasValues) => call<StorefrontView>(`${base(token)}/extras`, 'PUT', { expectedVersion, extras }),
  /** One tap for a repeat buyer: use the last order's address and delivery choice (copied on the server). */
  repeat: (token: string, expectedVersion: number) => call<StorefrontView>(`${base(token)}/repeat`, 'PUT', { expectedVersion }),
  /** A return or exchange request for the order this page shows. A replay of the same clientRequestId answers created: false. */
  requestReturn: (token: string, body: ReturnRequestBody) => call<{ created: boolean; order: StorefrontOrderView | null }>(`${base(token)}/returns`, 'POST', body),
  /** The wishlist: add or remove one variant, or save a browser's own list once. Every answer is the list. */
  wishlist: (token: string, body: { action: 'add' | 'remove'; variantId: string } | { action: 'sync'; variantIds: string[] }) =>
    call<{ currency: string | null; items: Array<{ variantId: string; productId: string; name: string; options: string; priceMinor: number | null; available: boolean }> }>(
      `${base(token)}/wishlist`, 'POST', body),
  place: (token: string, body: { expectedVersion: number; expectedTotalMinor: number; expectedPayableMinor: number; clientRequestId: string; marketingOptIn: boolean; email?: string; emailOffers?: boolean;
    buyerGstin?: string; buyerLegalName?: string }) =>
    call<{ created: boolean; view: StorefrontView | null }>(`${base(token)}/place`, 'POST', body),
  status: (token: string) => call<{ order: StorefrontOrderView | null }>(`${base(token)}/status`, 'GET'),
  /** One catalogue page: a name/description search, one category, and the cursor of the page before. */
  products: (token: string, filter: { q?: string; category?: string | null; cursor?: string | null }) => {
    const params = new URLSearchParams();
    if (filter.q?.trim()) params.set('q', filter.q.trim().slice(0, 80));
    if (filter.category) params.set('category', filter.category);
    if (filter.cursor) params.set('cursor', filter.cursor);
    const query = params.toString();
    return call<CataloguePage>(`${base(token)}/products${query ? `?${query}` : ''}`, 'GET');
  },
  imageUrl: (token: string, imageId: string) => `${base(token)}/images/${encodeURIComponent(imageId)}`,
};
