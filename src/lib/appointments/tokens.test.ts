import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveManageToken, isManageTokenFormat, manageTokenHash, manageUrl } from './tokens';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const ID = '11111111-1111-4111-8111-111111111111';
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = { key: process.env.ENCRYPTION_KEY, app: process.env.APP_URL };
  process.env.ENCRYPTION_KEY = KEY_A;
  process.env.APP_URL = 'https://app.example.test';
});
afterEach(() => {
  process.env.ENCRYPTION_KEY = saved.key;
  process.env.APP_URL = saved.app;
});

describe('manage tokens', () => {
  it('derives a stable 43-char base64url token per (id, epoch)', () => {
    const token = deriveManageToken(ID, 1);
    expect(isManageTokenFormat(token)).toBe(true);
    expect(deriveManageToken(ID, 1)).toBe(token);
  });

  it('stores only the sha256 hex hash', () => {
    const token = deriveManageToken(ID, 1);
    const hash = manageTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  it('rotates when the epoch is bumped', () => {
    expect(deriveManageToken(ID, 2)).not.toBe(deriveManageToken(ID, 1));
  });

  it('differs per appointment and per key', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(deriveManageToken(other, 1)).not.toBe(deriveManageToken(ID, 1));
    const a = deriveManageToken(ID, 1);
    process.env.ENCRYPTION_KEY = KEY_B;
    expect(deriveManageToken(ID, 1)).not.toBe(a);
  });

  it('refuses a missing or malformed key and a bad epoch', () => {
    process.env.ENCRYPTION_KEY = 'short';
    expect(() => deriveManageToken(ID, 1)).toThrow();
    process.env.ENCRYPTION_KEY = KEY_A;
    expect(() => deriveManageToken(ID, 0)).toThrow();
  });

  it('checks the format before any lookup', () => {
    expect(isManageTokenFormat('x'.repeat(43))).toBe(true);
    expect(isManageTokenFormat('x'.repeat(42))).toBe(false);
    expect(isManageTokenFormat('../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(isManageTokenFormat(null)).toBe(false);
  });

  it('builds the manage URL on the app origin', () => {
    expect(manageUrl('t'.repeat(43))).toBe(`https://app.example.test/my-booking/${'t'.repeat(43)}`);
  });
});
