import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accessCookieName, checkDownload, downloadQuery, hashShopPassword, signAccessCookie, signDownload, validShopPassword, verifyAccessCookie,
  verifyShopPassword,
} from './selling-tokens';

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const NOW = new Date('2026-12-05T10:00:00Z');
const account = randomUUID(), order = randomUUID();
const query = (expiresAt: Date, claim = { accountId: account, orderId: order }, key = KEY) => new URLSearchParams(downloadQuery(claim, expiresAt, key));
const parts = (q: URLSearchParams) => ({ accountId: q.get('a'), orderId: q.get('o'), expires: q.get('e'), signature: q.get('s') });

describe('signed download links', () => {
  it('accepts a link before its expiry and refuses it after', () => {
    expect(checkDownload(parts(query(new Date(NOW.getTime() + 60_000))), NOW, KEY)).toBe('ok');
    expect(checkDownload(parts(query(new Date(NOW.getTime() - 1))), NOW, KEY)).toBe('expired');
    expect(checkDownload(parts(query(new Date(NOW.getTime()))), NOW, KEY)).toBe('expired');
  });

  it('is invalid when any part is changed: order, account, expiry or signature', () => {
    const q = query(new Date(NOW.getTime() + 60_000));
    expect(checkDownload({ ...parts(q), orderId: randomUUID() }, NOW, KEY)).toBe('invalid');
    expect(checkDownload({ ...parts(q), accountId: randomUUID() }, NOW, KEY)).toBe('invalid');
    // Stretching the expiry does not extend the link.
    expect(checkDownload({ ...parts(q), expires: String(NOW.getTime() + 86_400_000) }, NOW, KEY)).toBe('invalid');
    const sig = q.get('s')!;
    expect(checkDownload({ ...parts(q), signature: `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}` }, NOW, KEY)).toBe('invalid');
  });

  it('is invalid under another key, and for a malformed value, before anything is compared', () => {
    const q = query(new Date(NOW.getTime() + 60_000));
    expect(checkDownload(parts(q), NOW, OTHER_KEY)).toBe('invalid');
    for (const bad of [null, undefined, '', 'x', 12, {}])
      expect(checkDownload({ ...parts(q), orderId: bad }, NOW, KEY)).toBe('invalid');
    expect(checkDownload({ ...parts(q), signature: 'short' }, NOW, KEY)).toBe('invalid');
    expect(checkDownload({ ...parts(q), expires: 'tomorrow' }, NOW, KEY)).toBe('invalid');
  });

  it('is case-insensitive about the ids only in the signature input, never accepting another order', () => {
    const upper = { accountId: account.toUpperCase(), orderId: order.toUpperCase() };
    expect(signDownload({ ...upper, expiresAtMs: 1_800_000_000_000 }, KEY)).toBe(signDownload({ accountId: account, orderId: order, expiresAtMs: 1_800_000_000_000 }, KEY));
    const q = query(new Date(NOW.getTime() + 60_000));
    expect(checkDownload({ ...parts(q), orderId: randomUUID() }, NOW, KEY)).toBe('invalid');
  });
});

describe('the shop password', () => {
  it('stores a salted hash and matches only the right password', () => {
    const stored = hashShopPassword('tulsi-2026');
    expect(stored).toMatch(/^scrypt\$16384\$/);
    expect(stored).not.toContain('tulsi');
    expect(hashShopPassword('tulsi-2026')).not.toBe(stored);
    expect(verifyShopPassword('tulsi-2026', stored)).toBe(true);
    expect(verifyShopPassword('tulsi-2027', stored)).toBe(false);
    expect(verifyShopPassword('', stored)).toBe(false);
    expect(verifyShopPassword('x'.repeat(2000), stored)).toBe(false);
  });

  it('never matches a missing or malformed stored value', () => {
    expect(verifyShopPassword('anything', null)).toBe(false);
    expect(verifyShopPassword('anything', 'plaintext')).toBe(false);
    expect(verifyShopPassword('anything', 'scrypt$1$a$b')).toBe(false);
    expect(verifyShopPassword('anything', 'scrypt$16384$salt$')).toBe(false);
  });

  it('accepts 6 to 72 printable characters as a new password', () => {
    expect(validShopPassword('abcdef')).toBe(true);
    expect(validShopPassword('abcde')).toBe(false);
    expect(validShopPassword('a'.repeat(72))).toBe(true);
    expect(validShopPassword('a'.repeat(73))).toBe(false);
    expect(validShopPassword('line\nbreak')).toBe(false);
    expect(validShopPassword(123456)).toBe(false);
  });
});

describe('the shop access cookie', () => {
  const hash = hashShopPassword('tulsi-2026');
  const later = new Date(NOW.getTime() + 86_400_000);

  it('opens the shop it was made for until it expires', () => {
    const cookie = signAccessCookie('kumar-oils', hash, later, KEY);
    expect(verifyAccessCookie(cookie, 'kumar-oils', hash, NOW, KEY)).toBe(true);
    expect(verifyAccessCookie(cookie, 'kumar-oils', hash, new Date(later.getTime() + 1), KEY)).toBe(false);
  });

  it('opens no other shop', () => {
    const cookie = signAccessCookie('kumar-oils', hash, later, KEY);
    expect(verifyAccessCookie(cookie, 'other-shop', hash, NOW, KEY)).toBe(false);
    expect(accessCookieName('kumar-oils')).not.toBe(accessCookieName('other-shop'));
  });

  it('stops working when the password changes or the shop leaves password mode', () => {
    const cookie = signAccessCookie('kumar-oils', hash, later, KEY);
    expect(verifyAccessCookie(cookie, 'kumar-oils', hashShopPassword('a-new-password'), NOW, KEY)).toBe(false);
    expect(verifyAccessCookie(cookie, 'kumar-oils', null, NOW, KEY)).toBe(false);
  });

  it('refuses a forged, stretched, empty or oversized cookie', () => {
    const cookie = signAccessCookie('kumar-oils', hash, later, KEY);
    const [, sig] = cookie.split('.');
    expect(verifyAccessCookie(`${later.getTime() + 999_999_999}.${sig}`, 'kumar-oils', hash, NOW, KEY)).toBe(false);
    expect(verifyAccessCookie(cookie, 'kumar-oils', hash, NOW, OTHER_KEY)).toBe(false);
    expect(verifyAccessCookie('', 'kumar-oils', hash, NOW, KEY)).toBe(false);
    expect(verifyAccessCookie(null, 'kumar-oils', hash, NOW, KEY)).toBe(false);
    expect(verifyAccessCookie('x'.repeat(200), 'kumar-oils', hash, NOW, KEY)).toBe(false);
    expect(verifyAccessCookie('nodot', 'kumar-oils', hash, NOW, KEY)).toBe(false);
  });
});
