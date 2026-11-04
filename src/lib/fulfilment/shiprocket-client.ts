// Shiprocket REST client (Phase 9, design §3, D2). Owner: T4.
//
// Server only. The login token is cached encrypted in
// courier_connections.token_enc (re-login when under a day is left, or once on
// a 401); 429 -> throttled (the caller reschedules). Every call goes through
// leaseFetch with a timeout and logs only status codes: never a token, a
// password, an address or a provider message.
//
// Assumptions not confirmed against Shiprocket's docs (design §0 "Unverified"):
// the login response carries no expiry, so a token is treated as valid for 9
// days (Shiprocket documents 10); a 401/403 on login and a 400/422 whose
// message mentions the credentials both mean "bad API user details".
import { leaseFetch as fetch } from '@/lib/jobs/lease';
import { ShipmentError } from './types';

type Env = Record<string, string | undefined>;

export const SHIPROCKET_API_BASE = 'https://apiv2.shiprocket.in/v1/external';
export const SHIPROCKET_HTTP_TIMEOUT_MS = 15_000;
/** Shiprocket documents 240 h; we keep a day of margin on top of the re-login threshold. */
export const SHIPROCKET_TOKEN_TTL_MS = 9 * 24 * 3_600_000;
/** Re-login when less than this is left. */
export const SHIPROCKET_TOKEN_REFRESH_MS = 24 * 3_600_000;

/** Emergency kill switch: SHIPROCKET_DISABLED=true stops every Shiprocket call on this deployment. */
export function shiprocketDisabled(env: Env = process.env): boolean {
  return env.SHIPROCKET_DISABLED?.trim() === 'true';
}

/**
 * Shiprocket's public tracking page for an AWB (for notices and the order card). The URL form is not confirmed by
 * Shiprocket's API docs (design §0); null for anything that is not an AWB.
 */
export { shipmentTrackingUrl as shiprocketTrackingUrl } from './types';

/**
 * rejected: a definite 4xx; unknown: 5xx, timeout or network (outcome ambiguous); auth: 401/403; throttled: 429;
 * unavailable: the login inside shiprocketCall failed ambiguously, so the business request was never sent (retry later).
 */
export type ShiprocketErrorKind = 'rejected' | 'unknown' | 'auth' | 'throttled' | 'unavailable';

export class ShiprocketError extends Error {
  constructor(
    readonly kind: ShiprocketErrorKind,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`shiprocket_${kind}`);
    this.name = 'ShiprocketError';
  }
}

export type ShiprocketMethod = 'GET' | 'POST';

/** The provider's message, only to classify a refusal (never logged or returned). */
function messageOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const parts = [b.message, b.error, b.errors].map((v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : ''));
  return parts.join(' ').slice(0, 2000);
}

/** A stable, log-safe code for a refusal: the HTTP status and, when recognised, a reason. */
function refusalCode(status: number, body: unknown): string {
  const message = messageOf(body);
  if (/(already|duplicate|exist)/i.test(message) && /order/i.test(message)) return 'duplicate_order';
  if (/wallet|balance|recharge/i.test(message)) return 'insufficient_balance';
  if (/serviceab|no courier/i.test(message)) return 'not_serviceable';
  return `http_${status}`;
}

/**
 * One HTTP request with an explicit token (or none, for login). Classifies the
 * outcome; never retries. The response body is returned only on 2xx.
 */
export async function shiprocketRequest<T = unknown>(
  token: string | null, method: ShiprocketMethod, path: string, body?: unknown,
): Promise<T> {
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  if (!path.startsWith('/') || path.includes('..') || path.includes('//')) throw new ShipmentError('invalid');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${SHIPROCKET_API_BASE}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(SHIPROCKET_HTTP_TIMEOUT_MS), redirect: 'error',
    });
  } catch {
    // Timeout or network: the request may have reached Shiprocket.
    throw new ShiprocketError('unknown', null, 'network');
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return json as T;
  console.error('[shiprocket] request refused', { status: res.status });
  if (res.status === 401 || res.status === 403) throw new ShiprocketError('auth', res.status, 'auth');
  if (res.status === 429) throw new ShiprocketError('throttled', 429, 'throttled');
  if (res.status >= 400 && res.status < 500) throw new ShiprocketError('rejected', res.status, refusalCode(res.status, json));
  throw new ShiprocketError('unknown', res.status, `http_${res.status}`);
}

/** POST /auth/login with the workspace's API user. Bad details -> ShiprocketError('auth'). */
export async function shiprocketLogin(email: string, password: string): Promise<{ token: string; expiresAt: Date }> {
  let body: { token?: unknown } | null;
  try {
    body = await shiprocketRequest<{ token?: unknown } | null>(null, 'POST', '/auth/login', { email, password });
  } catch (error) {
    // A login refusal is about the credentials (Shiprocket answers 400/422 for a wrong password on some accounts).
    if (error instanceof ShiprocketError && error.kind === 'rejected') throw new ShiprocketError('auth', error.status, 'auth');
    throw error;
  }
  const token = body?.token;
  if (typeof token !== 'string' || token.length < 10 || token.length > 3000) throw new ShiprocketError('unknown', 200, 'bad_login_response');
  return { token, expiresAt: new Date(Date.now() + SHIPROCKET_TOKEN_TTL_MS) };
}

/**
 * One authenticated call with the workspace's cached token (logs in when the
 * token is missing or ageing, and once more after a 401). Throws
 * ShipmentError not_configured / not_connected before any HTTP when the
 * deployment switched Shiprocket off or the workspace has no live connection.
 * A login refused with the stored details marks the connection token_invalid.
 */
export async function shiprocketCall<T = unknown>(
  accountId: string, method: ShiprocketMethod, path: string, body?: unknown,
): Promise<T> {
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  // Dynamic import: connection.ts imports this module for the login.
  const conn = await import('./connection');
  const secrets = await conn.loadCourierSecrets(accountId);
  if (!secrets) throw new ShipmentError('not_connected');
  if (secrets.status === 'token_invalid') throw new ShiprocketError('auth', null, 'token_invalid');

  const login = async (): Promise<string> => {
    if (!secrets.password) {
      await conn.markCourierAuthFailed(accountId, secrets.connectionId);
      throw new ShiprocketError('auth', null, 'auth');
    }
    try {
      const fresh = await shiprocketLogin(secrets.email, secrets.password);
      await conn.storeCourierToken(accountId, secrets.connectionId, fresh.token, fresh.expiresAt);
      return fresh.token;
    } catch (error) {
      if (error instanceof ShiprocketError && error.kind === 'auth') await conn.markCourierAuthFailed(accountId, secrets.connectionId);
      // A login timeout, 5xx or unreadable answer is ambiguous only for the login: the business call was never sent.
      if (error instanceof ShiprocketError && error.kind === 'unknown') throw new ShiprocketError('unavailable', error.status, error.code);
      throw error;
    }
  };

  const fresh = secrets.token && secrets.tokenExpiresAt && secrets.tokenExpiresAt.getTime() - Date.now() > SHIPROCKET_TOKEN_REFRESH_MS;
  let token = fresh ? secrets.token! : await login();
  try {
    return await shiprocketRequest<T>(token, method, path, body);
  } catch (error) {
    // A 401 was refused before anything happened: log in once more and repeat.
    if (!(error instanceof ShiprocketError) || error.kind !== 'auth' || error.status !== 401) throw error;
    token = await login();
    return shiprocketRequest<T>(token, method, path, body);
  }
}
