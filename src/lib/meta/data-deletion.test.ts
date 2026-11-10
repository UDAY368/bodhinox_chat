// Meta Data Deletion Request Callback: the signed_request is accepted only with a
// valid HMAC-SHA256 signature from one of our app secrets, and the payload must
// name the algorithm, a numeric user id and an issue time.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_CODE, deletionStatusUrl, newConfirmationCode, parseSignedRequest } from './data-deletion';

const SECRET = 'test-only-app-secret';
const enc = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
export function signed(payload: unknown, secret = SECRET): string {
  const body = enc(payload);
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
}
const payload = { algorithm: 'HMAC-SHA256', issued_at: 1_762_700_000, user_id: '1234567890' };

describe('parseSignedRequest', () => {
  it('accepts a request signed with any configured secret', () => {
    expect(parseSignedRequest(signed(payload), SECRET)).toEqual({ userId: '1234567890', issuedAt: 1_762_700_000 });
    expect(parseSignedRequest(signed(payload, 'second'), `other, second`)).toEqual({ userId: '1234567890', issuedAt: 1_762_700_000 });
    // Meta pads nothing, but a padded signature or a numeric user id still parses.
    expect(parseSignedRequest(signed({ ...payload, user_id: 42 }), SECRET)?.userId).toBe('42');
  });

  it('refuses a wrong secret, a tampered payload, no secret and malformed input', () => {
    expect(parseSignedRequest(signed(payload, 'attacker'), SECRET)).toBeNull();
    const [sig] = signed(payload).split('.');
    expect(parseSignedRequest(`${sig}.${enc({ ...payload, user_id: '999' })}`, SECRET)).toBeNull();
    expect(parseSignedRequest(signed(payload), '')).toBeNull();
    expect(parseSignedRequest(signed(payload), undefined)).toBeNull();
    for (const bad of [null, 42, '', 'abc', 'a.b.c', `${sig}.`, `!!.${enc(payload)}`, 'x'.repeat(5000)])
      expect(parseSignedRequest(bad, SECRET)).toBeNull();
  });

  it('refuses a validly signed payload with the wrong algorithm or fields', () => {
    expect(parseSignedRequest(signed({ ...payload, algorithm: 'none' }), SECRET)).toBeNull();
    expect(parseSignedRequest(signed({ ...payload, user_id: 'abc' }), SECRET)).toBeNull();
    expect(parseSignedRequest(signed({ ...payload, issued_at: 'now' }), SECRET)).toBeNull();
    expect(parseSignedRequest(signed({ ...payload, issued_at: -1 }), SECRET)).toBeNull();
    expect(parseSignedRequest(signed('not json'), SECRET)).toBeNull();
  });
});

describe('codes and status url', () => {
  it('issues unguessable codes the status page accepts', () => {
    const a = newConfirmationCode();
    expect(a).toMatch(CONFIRMATION_CODE);
    expect(newConfirmationCode()).not.toBe(a);
    expect(CONFIRMATION_CODE.test("x' OR 1=1")).toBe(false);
  });

  it('builds the public status link', () => {
    expect(deletionStatusUrl('https://app.example.in', 'abc123')).toBe('https://app.example.in/data-deletion?code=abc123');
  });
});
