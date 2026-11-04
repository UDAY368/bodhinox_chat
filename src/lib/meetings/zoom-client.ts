// Zoom REST and OAuth client (Phase 9, design §3). Owner: T2.
//
// Every call goes through leaseFetch (src/lib/jobs/lease.ts), so a job that
// lost its lease cannot reach Zoom, with a 15 s timeout (OAuth: 10 s). Only
// Zoom's numeric error code and the HTTP status are ever logged or kept:
// never a body, a token or a customer field. Nothing here reads the database;
// callers decide whether Zoom may be called at all (config.ts + a live
// connection), so a workspace that never connected Zoom never reaches here.
import { leaseFetch } from '@/lib/jobs/lease';
import type { ZoomConfig } from './config';

export const ZOOM_API_BASE = 'https://api.zoom.us/v2';
export const ZOOM_OAUTH_BASE = 'https://zoom.us/oauth';
export const ZOOM_HTTP_TIMEOUT_MS = 15_000;
export const ZOOM_OAUTH_TIMEOUT_MS = 10_000;

/** rejected: a definite 4xx; unknown: 5xx, timeout or network (outcome ambiguous); auth: 401; throttled: 429. */
export type ZoomErrorKind = 'rejected' | 'unknown' | 'auth' | 'throttled';

export class ZoomError extends Error {
  constructor(
    readonly kind: ZoomErrorKind,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(`zoom_${kind}`);
    this.name = 'ZoomError';
  }
}

export type ZoomMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** A relative API path: no scheme, no host, no dot segments (the base is fixed). */
const SAFE_PATH = /^\/[A-Za-z0-9_\-/@.%]+$/;

/** Zoom's own error code (a number in the JSON body) or OAuth's `error` string, as a short code. */
async function errorCode(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
  if (typeof body?.code === 'number' && Number.isSafeInteger(body.code)) return String(body.code);
  if (typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error)) return body.error;
  return null;
}

function classify(status: number): ZoomErrorKind {
  if (status === 401) return 'auth';
  if (status === 429) return 'throttled';
  if (status >= 400 && status < 500) return 'rejected';
  return 'unknown';
}

async function send(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  try {
    return await leaseFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.error(`[zoom] ${label} ${timeout ? 'timeout' : 'network'}`);
    throw new ZoomError('unknown', null, timeout ? 'timeout' : 'network');
  }
}

/**
 * One Zoom REST call with the workspace's access token. 2xx → parsed JSON (or
 * undefined for 204); anything else throws ZoomError. `query` values are
 * appended URL-encoded.
 */
export async function zoomCall<T = unknown>(
  token: string, method: ZoomMethod, path: string, body?: unknown, query?: Record<string, string>,
): Promise<T> {
  if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) throw new Error('Invalid Zoom path');
  const url = new URL(`${ZOOM_API_BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const response = await send(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, ZOOM_HTTP_TIMEOUT_MS, method);
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    const text = await response.text().catch(() => '');
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 2xx whose body we cannot read: the change happened, its details are unknown.
      throw new ZoomError('unknown', response.status, 'unreadable');
    }
  }
  const code = await errorCode(response);
  console.error(`[zoom] ${method} failed`, response.status, code ?? '-');
  throw new ZoomError(classify(response.status), response.status, code);
}

export interface ZoomTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  /** Granted scopes; null when Zoom's response did not list them. */
  scopes: string[] | null;
}

const basic = (config: ZoomConfig) => `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;

/**
 * POST /oauth/token (authorization_code or refresh_token). 400/401 (for
 * example invalid_grant) → ZoomError('auth'); 5xx, timeout or network →
 * ZoomError('unknown'). Never logs a token.
 */
export async function zoomTokenRequest(config: ZoomConfig, params: Record<string, string>): Promise<ZoomTokenGrant> {
  const response = await send(`${ZOOM_OAUTH_BASE}/token`, {
    method: 'POST',
    headers: { authorization: basic(config), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  }, ZOOM_OAUTH_TIMEOUT_MS, 'token');
  if (!response.ok) {
    const code = await errorCode(response);
    console.error('[zoom] token request failed', response.status, code ?? '-');
    const kind: ZoomErrorKind = response.status === 400 || response.status === 401 ? 'auth' : classify(response.status);
    throw new ZoomError(kind, response.status, code);
  }
  const body = (await response.json().catch(() => null)) as {
    access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown;
  } | null;
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
  const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
  if (!accessToken || !refreshToken || accessToken.length > 2048 || refreshToken.length > 2048)
    throw new ZoomError('unknown', response.status, 'unreadable');
  const expires = typeof body?.expires_in === 'number' && body.expires_in > 0 ? Math.min(body.expires_in, 86_400) : 3600;
  const scopes = typeof body?.scope === 'string'
    ? body.scope.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9:_.-]{1,100}$/.test(s)).slice(0, 50)
    : null;
  return { accessToken, refreshToken, expiresInSeconds: expires, scopes };
}

/** POST /oauth/revoke. Returns false (never throws) when Zoom could not confirm it. */
export async function zoomRevoke(config: ZoomConfig, token: string): Promise<boolean> {
  try {
    const response = await send(`${ZOOM_OAUTH_BASE}/revoke`, {
      method: 'POST',
      headers: { authorization: basic(config), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token }).toString(),
    }, ZOOM_OAUTH_TIMEOUT_MS, 'revoke');
    if (!response.ok) console.error('[zoom] revoke failed', response.status);
    return response.ok;
  } catch {
    return false;
  }
}
