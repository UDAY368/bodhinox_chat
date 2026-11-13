/**
 * Web Push (RFC 8030) with VAPID (RFC 8292), payload-free.
 *
 * A push carries no body: the service worker (public/sw.js) shows a generic
 * "new notification" alert and opens /notifications on click, so no title or
 * customer content ever reaches the browser vendor's push service. That also
 * means no message encryption (RFC 8291) is needed, only the VAPID signature.
 *
 * Configured by VAPID_PUBLIC_KEY (base64url, uncompressed P-256 point),
 * VAPID_PRIVATE_KEY (base64url, 32-byte scalar) and VAPID_SUBJECT (mailto: or
 * https: contact). Without all three, push is reported unavailable and the
 * settings page shows the column switched off. Generate a pair with
 * `npx web-push generate-vapid-keys` or any P-256 tool.
 *
 * Endpoints come from the browser, so only the known push services are
 * accepted (never an arbitrary URL the server would call).
 */
import { importJWK, SignJWT } from 'jose';

/** Hosts of the browser push services (Chrome/Edge/Opera, Firefox, Safari, Windows). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/];
const B64URL = /^[A-Za-z0-9_-]+$/;
/** Seconds a push service keeps an undelivered wake-up. */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** The VAPID settings, or null while push is not configured (or misconfigured). */
export function vapidConfig(env: Record<string, string | undefined> = process.env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!B64URL.test(publicKey) || !B64URL.test(privateKey)) return null;
  const pub = decode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4 || decode(privateKey).length !== 32) return null;
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/[^\s]+$/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function webPushAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return vapidConfig(env) !== null;
}

/** Whether the server may call this endpoint: https on a known push service, no credentials or odd ports. */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length < 10 || endpoint.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  return PUSH_HOSTS.some((host) => host.test(url.hostname));
}

/** Validate a browser PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }. */
export function parseSubscription(input: unknown): PushSubscriptionKeys | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: unknown };
  if (!isAllowedPushEndpoint(endpoint)) return null;
  if (!keys || typeof keys !== 'object') return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!B64URL.test(p256dh) || !B64URL.test(auth)) return null;
  if (decode(p256dh).length !== 65 || decode(auth).length !== 16) return null;
  return { endpoint, p256dh, auth };
}

/** The VAPID Authorization header value for one endpoint (valid 12 hours). */
export async function vapidAuthorization(endpoint: string, config: VapidConfig, now: Date = new Date()): Promise<string> {
  const pub = decode(config.publicKey);
  const key = await importJWK({
    kty: 'EC',
    crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'),
    y: pub.subarray(33, 65).toString('base64url'),
    d: config.privateKey,
  }, 'ES256');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(issuedAt + 12 * 60 * 60)
    .setSubject(config.subject)
    .sign(key);
  return `vapid t=${jwt}, k=${config.publicKey}`;
}

/**
 * gone: the subscription no longer exists (404/410) and should be deleted;
 * retry: the push service did not take it (429/5xx, network); rejected: any other refusal.
 */
export type PushOutcome = 'sent' | 'gone' | 'retry' | 'rejected';

export type PushFetch = (url: string, init: RequestInit) => Promise<{ status: number }>;

/** Send one payload-free push. Never throws; never logs the endpoint. */
export async function sendWebPush(
  subscription: Pick<PushSubscriptionKeys, 'endpoint'>,
  options: { config?: VapidConfig | null; fetch?: PushFetch; urgency?: 'normal' | 'high'; now?: Date } = {},
): Promise<PushOutcome> {
  const config = options.config === undefined ? vapidConfig() : options.config;
  if (!config || !isAllowedPushEndpoint(subscription.endpoint)) return 'rejected';
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  try {
    const response = await send(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(subscription.endpoint, config, options.now),
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: options.urgency ?? 'normal',
        'Content-Length': '0',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 300) return 'sent';
    if (response.status === 404 || response.status === 410) return 'gone';
    if (response.status === 429 || response.status >= 500) return 'retry';
    return 'rejected';
  } catch {
    return 'retry';
  }
}
