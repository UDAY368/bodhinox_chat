'use client';

/**
 * What the public shop's browser keeps about checkout (localStorage, one key
 * per shop; every read and write guarded, as in cart-store.ts):
 * - the latest checkout link token with its expiry, so the cart page's
 *   Checkout button goes back to it without a new code while it is valid;
 * - the pincode and coupon the buyer typed on the cart page, carried once
 *   into the checkout so they are not typed twice;
 * - a one-time "replace the checkout's cart with the browser cart" mark set by
 *   that Checkout button.
 * The token is only ever sent back to this shop's own pages and APIs.
 */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const tokenKey = (handle: string) => `bodhinox-checkout:${handle}`;
const carryKey = (handle: string) => `bodhinox-checkout-carry:${handle}`;
const replaceKey = (handle: string) => `bodhinox-checkout-replace:${handle}`;

function read(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: nothing kept */ }
}

/** A remembered checkout that is still open, or null (an expired one is forgotten). */
export function readCheckout(handle: string, now = Date.now()): { token: string; expiresAt: string } | null {
  const value = read(tokenKey(handle)) as { token?: unknown; expiresAt?: unknown } | null;
  if (!value || typeof value.token !== 'string' || !TOKEN.test(value.token) || typeof value.expiresAt !== 'string') return null;
  const ends = Date.parse(value.expiresAt);
  if (!Number.isFinite(ends) || ends <= now) { write(tokenKey(handle), null); return null; }
  return { token: value.token, expiresAt: value.expiresAt };
}

export function rememberCheckout(handle: string, token: string, expiresAt: string): void {
  if (TOKEN.test(token)) write(tokenKey(handle), { token, expiresAt });
}

export function forgetCheckout(handle: string): void {
  write(tokenKey(handle), null);
}

export interface CheckoutCarry { pincode: string | null; coupon: string | null }

export function writeCarry(handle: string, carry: CheckoutCarry): void {
  write(carryKey(handle), carry.pincode || carry.coupon ? carry : null);
}

/** The carried pincode and coupon, read once (then cleared). */
export function takeCarry(handle: string): CheckoutCarry | null {
  const value = read(carryKey(handle)) as { pincode?: unknown; coupon?: unknown } | null;
  write(carryKey(handle), null);
  if (!value) return null;
  const pincode = typeof value.pincode === 'string' && /^[1-9][0-9]{5}$/.test(value.pincode) ? value.pincode : null;
  const coupon = typeof value.coupon === 'string' && /^[A-Z0-9_-]{3,32}$/.test(value.coupon) ? value.coupon : null;
  return pincode || coupon ? { pincode, coupon } : null;
}

export function markReplaceCart(handle: string): void {
  write(replaceKey(handle), true);
}

/** True once after the cart page's Checkout button: the checkout takes the browser cart as it is now. */
export function takeReplaceCart(handle: string): boolean {
  const marked = read(replaceKey(handle)) === true;
  if (marked) write(replaceKey(handle), null);
  return marked;
}
