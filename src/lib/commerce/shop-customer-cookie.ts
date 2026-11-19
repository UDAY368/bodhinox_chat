/**
 * The buyer's account cookie on the public shop (store plan Phase 5), and the
 * few pure rules around it. No database, so the browser bundle and the unit
 * tests can read it.
 *
 * One cookie per shop: HttpOnly, Secure in production, SameSite=Lax and
 * Path=/s/<handle>. The account pages and the account API both live under
 * that path (/s/<handle>/account/**), so one cookie covers them and it is
 * never sent to another shop, the dashboard or any /api route.
 */
export const CUSTOMER_COOKIE = 'shop_customer';
export const CUSTOMER_SESSION_DAYS = 30;
/** 32 random bytes in base64url. */
export const CUSTOMER_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_SAVED_ADDRESSES = 5;
export const ACCOUNT_ORDERS_PAGE_SIZE = 10;

export const customerCookiePath = (handle: string) => `/s/${handle}`;
export const accountApiPath = (handle: string) => `/s/${handle}/account/api`;

export interface CustomerCookieOptions { httpOnly: true; secure: boolean; sameSite: 'lax'; path: string; maxAge: number }

/** `maxAge` 0 clears the cookie (sign-out). */
export function customerCookieOptions(handle: string, maxAge = CUSTOMER_SESSION_DAYS * 86_400): CustomerCookieOptions {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: customerCookiePath(handle), maxAge };
}

/** The account cookie's value in a request's Cookie header, when it has the token's shape. */
export function customerTokenFrom(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader || cookieHeader.length > 16_384) return null;
  for (const part of cookieHeader.split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === CUSTOMER_COOKIE) {
      const value = part.slice(at + 1).trim();
      if (CUSTOMER_TOKEN.test(value)) return value;
    }
  }
  return null;
}

/** "+91 ••••• •3210": the country code and the last four digits, nothing else. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8) return '••••';
  const code = Math.min(3, Math.max(1, digits.length - 10));
  const hidden = digits.length - code - 4;
  return `+${digits.slice(0, code)} ${'•'.repeat(hidden - 1)}${hidden > 1 ? ' ' : ''}•${digits.slice(-4)}`;
}

/** A whole page number from a query value, 1 to 1000. */
export function accountPage(value: unknown): number {
  return typeof value === 'string' && /^\d{1,4}$/.test(value) ? Math.min(1000, Math.max(1, Number(value))) : 1;
}
