import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOtpVerify } from './public-shop';
import { checkoutAsCustomer, startSignIn } from './shop-customer';
import {
  accountPage, CUSTOMER_COOKIE, CUSTOMER_TOKEN, customerCookieOptions, customerTokenFrom, maskPhone,
} from './shop-customer-cookie';
import { StoreError } from './store-settings';

const token = () => randomBytes(32).toString('base64url');

describe('buyer account cookie', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is HttpOnly, SameSite=Lax, 30 days and scoped to the one shop', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(customerCookieOptions('amrita-oils')).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/s/amrita-oils', maxAge: 30 * 86_400 });
  });

  it('is Secure only in production, and maxAge 0 clears it on the same path', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(customerCookieOptions('amrita-oils', 0)).toMatchObject({ httpOnly: true, secure: false, path: '/s/amrita-oils', maxAge: 0 });
  });

  it('reads only a well-formed token from the Cookie header', () => {
    const value = token();
    expect(value).toMatch(CUSTOMER_TOKEN);
    expect(customerTokenFrom(`a=b; ${CUSTOMER_COOKIE}=${value}; other=1`)).toBe(value);
    expect(customerTokenFrom(`x${CUSTOMER_COOKIE}=${value}`)).toBeNull();
    expect(customerTokenFrom(`${CUSTOMER_COOKIE}=short`)).toBeNull();
    expect(customerTokenFrom(`${CUSTOMER_COOKIE}=${value}' OR 1=1`)).toBeNull();
    expect(customerTokenFrom(null)).toBeNull();
    expect(customerTokenFrom('')).toBeNull();
  });
});

describe('phone masking', () => {
  it('shows the country code and the last four digits only', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ••••• •3210');
    expect(maskPhone('919876543210')).toBe('+91 ••••• •3210');
    expect(maskPhone('+14155550123')).toBe('+1 ••••• •0123');
    expect(maskPhone('+9715012345678')).toBe('+971 ••••• •5678');
  });

  it('never shows the middle digits, and hides a number too short to mask', () => {
    for (const phone of ['+919876543210', '+4915112345678', '+6591234567']) {
      const masked = maskPhone(phone);
      expect(masked.replace(/\D/g, '').length).toBeLessThanOrEqual(7);
      expect(masked).not.toContain(phone.slice(4, 9));
    }
    expect(maskPhone('12345')).toBe('••••');
  });
});

describe('account input validation', () => {
  it('parses a page number from the query, 1 to 1000', () => {
    expect(accountPage('3')).toBe(3);
    expect(accountPage('0')).toBe(1);
    expect(accountPage('99999')).toBe(1);
    expect(accountPage('5000')).toBe(1000);
    expect(accountPage('2; DROP')).toBe(1);
    expect(accountPage(['2'])).toBe(1);
    expect(accountPage(undefined)).toBe(1);
  });

  it('refuses a malformed challenge id or code before any lookup', () => {
    expect(parseOtpVerify({ challengeId: randomUUID(), code: ' 123456 ' }).code).toBe('123456');
    for (const bad of [{ challengeId: 'x', code: '123456' }, { challengeId: randomUUID(), code: '12345' }, { challengeId: randomUUID(), code: 123456 },
      { challengeId: null, code: '123456' }])
      expect(() => parseOtpVerify(bad)).toThrowError(StoreError);
  });

  it('refuses a sign-in without a full international number before any lookup', () => {
    for (const phone of ['9876543210', '', null, '+91', 'abc'])
      expect(() => startSignIn('amrita-oils', { phone, clientIp: '203.0.113.1' })).toThrowError(StoreError);
  });

  it('refuses a malformed cart or address id on "check out as" before any lookup', () => {
    const cart = [{ variantId: randomUUID(), qty: 1 }];
    expect(() => checkoutAsCustomer('amrita-oils', token(), { cart: [] })).toThrowError(StoreError);
    expect(() => checkoutAsCustomer('amrita-oils', token(), { cart: [{ variantId: 'x', qty: 1 }] })).toThrowError(StoreError);
    expect(() => checkoutAsCustomer('amrita-oils', token(), { cart, addressId: "1' OR '1'='1" })).toThrowError(StoreError);
  });
});
