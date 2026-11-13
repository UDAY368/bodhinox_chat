import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { isAllowedPushEndpoint, parseSubscription, sendWebPush, vapidAuthorization, vapidConfig, webPushAvailable } from './web-push';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]);
  return { VAPID_PUBLIC_KEY: point.toString('base64url'), VAPID_PRIVATE_KEY: priv.d!, VAPID_SUBJECT: 'mailto:ops@example.test' };
}
const env = keys();
const config = vapidConfig(env)!;
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';

describe('VAPID configuration', () => {
  it('is unavailable (a graceful off state) until all three keys are set and valid', () => {
    expect(webPushAvailable({})).toBe(false);
    expect(webPushAvailable({ ...env, VAPID_SUBJECT: '' })).toBe(false);
    expect(webPushAvailable({ ...env, VAPID_PUBLIC_KEY: 'short' })).toBe(false);
    expect(webPushAvailable({ ...env, VAPID_SUBJECT: 'not-a-contact' })).toBe(false);
    expect(webPushAvailable(env)).toBe(true);
  });

  it('signs an ES256 token for the push service origin', async () => {
    const header = await vapidAuthorization(FCM, config, new Date('2026-11-13T00:00:00Z'));
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const jwt = header.slice('vapid t='.length, header.indexOf(','));
    expect(decodeProtectedHeader(jwt).alg).toBe('ES256');
    expect(decodeJwt(jwt)).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:ops@example.test' });
  });
});

describe('push endpoints', () => {
  it('accepts only https endpoints of known push services', () => {
    expect(isAllowedPushEndpoint(FCM)).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://169.254.169.254/latest',
      'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 42, null])
      expect(isAllowedPushEndpoint(bad), String(bad)).toBe(false);
  });

  it('validates a browser subscription’s keys', () => {
    const p256dh = Buffer.alloc(65, 4).toString('base64url');
    const auth = Buffer.alloc(16, 1).toString('base64url');
    expect(parseSubscription({ endpoint: FCM, keys: { p256dh, auth } })).toEqual({ endpoint: FCM, p256dh, auth });
    expect(parseSubscription({ endpoint: 'https://evil.example/x', keys: { p256dh, auth } })).toBeNull();
    expect(parseSubscription({ endpoint: FCM, keys: { p256dh: 'x', auth } })).toBeNull();
    expect(parseSubscription({ endpoint: FCM })).toBeNull();
  });
});

describe('sendWebPush', () => {
  it('sends an empty, signed POST and maps the answer', async () => {
    const fetch = vi.fn(async () => ({ status: 201 }));
    expect(await sendWebPush({ endpoint: FCM }, { config, fetch })).toBe('sent');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(FCM);
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Length']).toBe('0');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^vapid t=/);
    expect(init.redirect).toBe('error');
    expect(await sendWebPush({ endpoint: FCM }, { config, fetch: async () => ({ status: 410 }) })).toBe('gone');
    expect(await sendWebPush({ endpoint: FCM }, { config, fetch: async () => ({ status: 503 }) })).toBe('retry');
    expect(await sendWebPush({ endpoint: FCM }, { config, fetch: async () => ({ status: 403 }) })).toBe('rejected');
    expect(await sendWebPush({ endpoint: FCM }, { config, fetch: async () => { throw new Error('offline'); } })).toBe('retry');
  });

  it('never calls an endpoint outside the push services, or without keys', async () => {
    const fetch = vi.fn(async () => ({ status: 201 }));
    expect(await sendWebPush({ endpoint: 'https://evil.example/x' }, { config, fetch })).toBe('rejected');
    expect(await sendWebPush({ endpoint: FCM }, { config: null, fetch })).toBe('rejected');
    expect(fetch).not.toHaveBeenCalled();
  });
});
