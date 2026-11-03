import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveManageToken } from '../appointments/tokens';
import { deriveStorefrontToken, isStorefrontTokenFormat, storefrontTokenHash, storefrontUrl } from './storefront-token';

const ID = '11111111-1111-4111-8111-111111111111';
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { key: process.env.ENCRYPTION_KEY, app: process.env.APP_URL };
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.APP_URL = 'https://app.example.test';
});
afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key;
  process.env.APP_URL = saved.app;
});

describe('storefront tokens', () => {
  it('derives a stable token per (session, epoch), rotated by the epoch and the key', () => {
    const token = deriveStorefrontToken(ID, 1);
    expect(isStorefrontTokenFormat(token)).toBe(true);
    expect(deriveStorefrontToken(ID, 1)).toBe(token);
    expect(deriveStorefrontToken(ID, 2)).not.toBe(token);
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    expect(deriveStorefrontToken(ID, 1)).not.toBe(token);
  });

  it('is separated from appointment manage links by its HKDF info', () => {
    expect(deriveStorefrontToken(ID, 1)).not.toBe(deriveManageToken(ID, 1));
  });

  it('stores only the sha256 hash and builds the /shop/ URL', () => {
    const token = deriveStorefrontToken(ID, 1);
    expect(storefrontTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(storefrontUrl(token)).toBe(`https://app.example.test/shop/${token}`);
  });

  it('refuses a bad epoch, a missing key and malformed tokens', () => {
    expect(() => deriveStorefrontToken(ID, 0)).toThrow(RangeError);
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => deriveStorefrontToken(ID, 1)).toThrow(/ENCRYPTION_KEY/);
    for (const bad of ['', 'a'.repeat(42), `${'a'.repeat(42)}=`, null, 1]) expect(isStorefrontTokenFormat(bad)).toBe(false);
  });
});
