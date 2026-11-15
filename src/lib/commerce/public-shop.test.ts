import { describe, expect, it } from 'vitest';
import {
  CART_CODE, cartCodeMessage, isShopHandleFormat, newCartCode, newOtpCode, normaliseBuyerPhone, otpHash, parseCartLines,
  parseShopOrderMessage,
} from './public-shop';
import { StoreError } from './store-settings';

process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const V1 = '0b8c3c3e-8a5e-4d6c-9a52-0f6f2b1d2e3f';
const V2 = '1c9d4d4f-9b6f-4e7d-8b63-1a7a3c2e3f40';

describe('public shop helpers', () => {
  it('reads "ORDER <CODE>" only at the end of the message', () => {
    expect(parseShopOrderMessage('Hi Shop, I would like to order:\n• 2 × Tulsi\n\nORDER ABC234')).toBe('ABC234');
    expect(parseShopOrderMessage('  order   xyz789 ')).toBe('XYZ789');
    expect(parseShopOrderMessage('ORDER ABC234 please')).toBeNull();
    // 0, 1, I and O are never in a code.
    expect(parseShopOrderMessage('ORDER ABC10O')).toBeNull();
    expect(parseShopOrderMessage('BORDER ABC234')).toBeNull();
    expect(parseShopOrderMessage(`${'x'.repeat(2001)} ORDER ABC234`)).toBeNull();
    expect(parseShopOrderMessage(null)).toBeNull();
  });

  it('makes codes from the unambiguous alphabet and six-digit one-time codes', () => {
    for (let i = 0; i < 200; i++) {
      expect(newCartCode()).toMatch(CART_CODE);
      expect(newOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('binds a one-time code hash to its challenge', () => {
    const a = otpHash(V1, '123456');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(otpHash(V1, '123456')).toBe(a);
    expect(otpHash(V2, '123456')).not.toBe(a);
    expect(otpHash(V1, '123457')).not.toBe(a);
  });

  it('accepts only international phone numbers', () => {
    expect(normaliseBuyerPhone('+91 98765-43210')).toBe('+919876543210');
    expect(normaliseBuyerPhone('9876543210')).toBeNull();
    expect(normaliseBuyerPhone('+12')).toBeNull();
    expect(normaliseBuyerPhone(919876543210)).toBeNull();
  });

  it('normalises a browser cart and refuses anything malformed', () => {
    expect(parseCartLines([{ variantId: V1, qty: 1 }, { variantId: V1, qty: 2 }, { variantId: V2, qty: 1 }]))
      .toEqual([{ variantId: V1, qty: 3 }, { variantId: V2, qty: 1 }]);
    for (const bad of [[], null, 'x', [{ variantId: 'nope', qty: 1 }], [{ variantId: V1, qty: 0 }], [{ variantId: V1, qty: 1.5 }],
      Array.from({ length: 51 }, () => ({ variantId: V1, qty: 1 }))])
      expect(() => parseCartLines(bad)).toThrow(StoreError);
  });

  it('writes the WhatsApp order message with the code on the last line', () => {
    const text = cartCodeMessage('Kumar', [
      { variantId: V1, productId: V2, name: 'Tulsi', options: { Size: '100g' }, qty: 2, unitPriceMinor: 100, lineTotalMinor: 200, available: null },
    ], 'ABC234');
    expect(text.split('\n').at(-1)).toBe('ORDER ABC234');
    expect(text).toContain('2 × Tulsi (100g)');
    expect(parseShopOrderMessage(text)).toBe('ABC234');
  });

  it('checks handle format before any database work', () => {
    expect(isShopHandleFormat('kumar-ayurveda')).toBe(true);
    expect(isShopHandleFormat("x' OR 1=1 --")).toBe(false);
    expect(isShopHandleFormat('../etc')).toBe(false);
  });
});
