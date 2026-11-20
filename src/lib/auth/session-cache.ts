// Short per-process cache of resolved sign-in sessions (batch 5). Every signed-in request
// resolved its session with a database query, and every mutation read the CSRF hash with a
// second one; the realtime stream resolves its session on every tick. A resolved session is
// kept here for SESSION_CACHE_TTL_MS, keyed by the SHA-256 of the exact access token (a
// cached entry is never served for any other token), bounded to SESSION_CACHE_MAX entries
// (least recently used dropped first).
//
// Revocation: a session revoked, a member removed or a role changed in THIS process drops the
// matching entries at once (forgetCachedSessions, called next to each of those writes). A
// change made by another process applies here within the TTL.

import { createHash } from 'node:crypto';

export const SESSION_CACHE_TTL_MS = 5_000;
export const SESSION_CACHE_MAX = 5_000;

export interface CachedSession<T> {
  value: T;
  userId: string;
  accountId: string;
  sessionId: string;
  csrfHash: string;
  /** Epoch ms after which the entry is not served. */
  until: number;
}

const entries = new Map<string, CachedSession<unknown>>();

export const sessionCacheKey = (token: string): string => createHash('sha256').update(token).digest('hex');

export function readCachedSession<T>(key: string, now: number = Date.now()): CachedSession<T> | null {
  const hit = entries.get(key);
  if (!hit) return null;
  entries.delete(key);
  if (hit.until <= now) return null;
  entries.set(key, hit); // most recently used last
  return hit as CachedSession<T>;
}

export function writeCachedSession<T>(key: string, entry: Omit<CachedSession<T>, 'until'>, maxUntil: number, now: number = Date.now()): void {
  entries.delete(key);
  const until = Math.min(now + SESSION_CACHE_TTL_MS, maxUntil);
  if (until <= now) return;
  entries.set(key, { ...entry, until });
  while (entries.size > SESSION_CACHE_MAX) entries.delete(entries.keys().next().value as string);
}

/**
 * Drops every cached session matching all the given fields: a user's sessions, one
 * session, or one member of one workspace. Call it next to any write that revokes a
 * session, removes a membership or changes a role.
 */
export function forgetCachedSessions(match: { userId?: string; accountId?: string; sessionId?: string }): void {
  if (!match.userId && !match.accountId && !match.sessionId) return;
  for (const [key, entry] of entries) {
    if ((match.userId === undefined || entry.userId === match.userId)
      && (match.accountId === undefined || entry.accountId === match.accountId)
      && (match.sessionId === undefined || entry.sessionId === match.sessionId)) entries.delete(key);
  }
}

/** Test hook. */
export function clearSessionCacheForTests(): void {
  entries.clear();
}
