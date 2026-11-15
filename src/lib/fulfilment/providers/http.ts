// One HTTP request to a courier API for the Delhivery and Shipway adapters (store Phase 5).
//
// Server only. Classifies the outcome (never retries), keeps a timeout and refuses redirects, and logs a status code
// at most: never a token, a header, a body or an address. The caller passes the fetch (leaseFetch in production, a
// stub in unit tests).
import { CourierError, type FetchLike } from './types';

export const COURIER_HTTP_TIMEOUT_MS = 15_000;

export interface CourierHttpResult {
  status: number;
  json: unknown;
  text: string;
}

/**
 * 2xx -> the parsed body (json is null when the body is not JSON). 401/403 -> auth; 429 -> throttled; other 4xx ->
 * rejected (code http_<status>); 5xx, a timeout or a network error -> unknown (the outcome is ambiguous).
 */
export async function courierRequest(
  fetchImpl: FetchLike, prefix: string, url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
): Promise<CourierHttpResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(COURIER_HTTP_TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new CourierError('unknown', null, 'network', prefix);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.ok) return { status: res.status, json, text };
  console.error(`[${prefix}] request refused`, { status: res.status });
  if (res.status === 401 || res.status === 403) throw new CourierError('auth', res.status, 'auth', prefix);
  if (res.status === 429) throw new CourierError('throttled', 429, 'throttled', prefix);
  if (res.status >= 400 && res.status < 500) throw new CourierError('rejected', res.status, `http_${res.status}`, prefix);
  throw new CourierError('unknown', res.status, `http_${res.status}`, prefix);
}

export const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A lower-case slug of a scan label, for the provider_code column (at most `max` characters). */
export function slug(value: unknown, max = 32): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, max) : '';
}
