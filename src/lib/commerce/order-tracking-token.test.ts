import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { orderTrackingToken, orderTrackingUrl, readOrderTrackingToken } from './order-tracking-token';

beforeAll(() => { process.env.ENCRYPTION_KEY = 'b'.repeat(64); process.env.APP_URL = 'https://app.example.test'; });

describe('order tracking token', () => {
  it('round-trips the account and order and is 64 url-safe characters', () => {
    const accountId = randomUUID(), orderId = randomUUID();
    const token = orderTrackingToken(accountId, orderId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(readOrderTrackingToken(token)).toEqual({ accountId, orderId });
    expect(orderTrackingUrl('shop-1', token)).toBe(`https://app.example.test/s/shop-1/track/${token}`);
  });
  it('refuses a changed id, a changed mac, other lengths and non-strings', () => {
    const token = orderTrackingToken(randomUUID(), randomUUID());
    const flip = (i: number) => `${token.slice(0, i)}${token[i] === 'A' ? 'B' : 'A'}${token.slice(i + 1)}`;
    expect(readOrderTrackingToken(flip(3))).toBeNull();
    expect(readOrderTrackingToken(flip(30))).toBeNull();
    expect(readOrderTrackingToken(flip(60))).toBeNull();
    expect(readOrderTrackingToken(token.slice(1))).toBeNull();
    expect(readOrderTrackingToken(`${token}A`)).toBeNull();
    expect(readOrderTrackingToken(undefined)).toBeNull();
    expect(readOrderTrackingToken('x'.repeat(64))).toBeNull();
  });
  it('is invalid under another key', () => {
    const token = orderTrackingToken(randomUUID(), randomUUID());
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    expect(readOrderTrackingToken(token)).toBeNull();
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
  });
  it('gives different tokens to different orders', () => {
    const a = randomUUID();
    expect(orderTrackingToken(a, randomUUID())).not.toBe(orderTrackingToken(a, randomUUID()));
  });
});
