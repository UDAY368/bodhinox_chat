/**
 * Browser helpers for the anonymous storefront APIs. Plain same-origin fetch:
 * no session, no CSRF header (the routes check Origin, which the browser sets
 * on PUT and POST). Errors are code-only.
 */
import type { StorefrontOrderView, StorefrontView } from '@/lib/commerce/storefront';
import type { Quote } from '@/lib/commerce/pricing';

export type { StorefrontOrderView, StorefrontView, Quote };

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
  'cod_unavailable', 'error',
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
  place: (token: string, body: { expectedVersion: number; expectedTotalMinor: number; clientRequestId: string; marketingOptIn: boolean }) =>
    call<{ created: boolean; view: StorefrontView | null }>(`${base(token)}/place`, 'POST', body),
  status: (token: string) => call<{ order: StorefrontOrderView | null }>(`${base(token)}/status`, 'GET'),
  imageUrl: (token: string, imageId: string) => `${base(token)}/images/${encodeURIComponent(imageId)}`,
};
