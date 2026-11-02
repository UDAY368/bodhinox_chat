import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateWooSecret, isWooPing, verifyWooSignature } from './signature';

const sign = (body: string | Buffer, secret: string) => createHmac('sha256', secret).update(body).digest('base64');

describe('verifyWooSignature', () => {
  const secret = 'test-only-secret';
  const body = '{"id":1001,"status":"processing"}';

  it('accepts the base64 HMAC-SHA256 of the exact raw body', () => {
    expect(verifyWooSignature(body, sign(body, secret), secret)).toBe(true);
    expect(verifyWooSignature(Buffer.from(body), ` ${sign(body, secret)} `, secret)).toBe(true);
  });

  it('refuses a tampered body, wrong secret, hex digest, missing or malformed header', () => {
    expect(verifyWooSignature(`${body} `, sign(body, secret), secret)).toBe(false);
    expect(verifyWooSignature(body, sign(body, 'other'), secret)).toBe(false);
    expect(verifyWooSignature(body, createHmac('sha256', secret).update(body).digest('hex'), secret)).toBe(false);
    expect(verifyWooSignature(body, null, secret)).toBe(false);
    expect(verifyWooSignature(body, '', secret)).toBe(false);
    expect(verifyWooSignature(body, 'not base64!', secret)).toBe(false);
    expect(verifyWooSignature(body, sign(body, secret), '')).toBe(false);
  });
});

describe('generateWooSecret / isWooPing', () => {
  it('generates distinct url-safe 256-bit secrets', () => {
    const a = generateWooSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateWooSecret()).not.toBe(a);
  });

  it('recognises only the bare creation ping body', () => {
    expect(isWooPing('webhook_id=42')).toBe(true);
    expect(isWooPing('webhook_id=42&x=1')).toBe(false);
    expect(isWooPing('{"id":1}')).toBe(false);
  });
});
