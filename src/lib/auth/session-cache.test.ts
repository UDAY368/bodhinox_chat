import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionCacheForTests, forgetCachedSessions, readCachedSession, SESSION_CACHE_MAX, SESSION_CACHE_TTL_MS,
  sessionCacheKey, writeCachedSession,
} from './session-cache';

const entry = (userId: string, accountId = 'acct-1', sessionId = `s-${userId}`) =>
  ({ value: { userId }, userId, accountId, sessionId, csrfHash: 'a'.repeat(64) });
const NOW = 1_000_000;

beforeEach(() => clearSessionCacheForTests());

describe('session cache', () => {
  it('keys by a hash of the exact token and never serves another token', () => {
    expect(sessionCacheKey('token-a')).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCacheKey('token-a')).not.toContain('token-a');
    writeCachedSession(sessionCacheKey('token-a'), entry('u1'), NOW + 60_000, NOW);
    expect(readCachedSession(sessionCacheKey('token-a'), NOW)?.userId).toBe('u1');
    expect(readCachedSession(sessionCacheKey('token-b'), NOW)).toBeNull();
    expect(readCachedSession(sessionCacheKey('token-a '), NOW)).toBeNull();
  });

  it('expires after the TTL, and never outlives the session itself', () => {
    writeCachedSession('k1', entry('u1'), NOW + 60_000, NOW);
    expect(readCachedSession('k1', NOW + SESSION_CACHE_TTL_MS - 1)).not.toBeNull();
    expect(readCachedSession('k1', NOW + SESSION_CACHE_TTL_MS)).toBeNull();
    writeCachedSession('k2', entry('u2'), NOW + 1_000, NOW);
    expect(readCachedSession('k2', NOW + 1_000)).toBeNull();
    writeCachedSession('k3', entry('u3'), NOW, NOW); // already expired: not stored
    expect(readCachedSession('k3', NOW)).toBeNull();
  });

  it('forgets a user, a session, or one member of one workspace', () => {
    writeCachedSession('a', entry('u1', 'acct-1', 's1'), NOW + 60_000, NOW);
    writeCachedSession('b', entry('u1', 'acct-2', 's2'), NOW + 60_000, NOW);
    writeCachedSession('c', entry('u2', 'acct-1', 's3'), NOW + 60_000, NOW);
    forgetCachedSessions({ userId: 'u1', accountId: 'acct-1' });
    expect(readCachedSession('a', NOW)).toBeNull();
    expect(readCachedSession('b', NOW)).not.toBeNull();
    forgetCachedSessions({ sessionId: 's3' });
    expect(readCachedSession('c', NOW)).toBeNull();
    forgetCachedSessions({ userId: 'u1' });
    expect(readCachedSession('b', NOW)).toBeNull();
  });

  it('an empty match forgets nothing', () => {
    writeCachedSession('a', entry('u1'), NOW + 60_000, NOW);
    forgetCachedSessions({});
    expect(readCachedSession('a', NOW)).not.toBeNull();
  });

  it('stays bounded, dropping the least recently used entry first', () => {
    for (let i = 0; i < SESSION_CACHE_MAX; i++) writeCachedSession(`k${i}`, entry(`u${i}`), NOW + 60_000, NOW);
    expect(readCachedSession('k0', NOW)).not.toBeNull(); // k0 is now the most recently used
    writeCachedSession('extra', entry('extra'), NOW + 60_000, NOW);
    expect(readCachedSession('k0', NOW)).not.toBeNull();
    expect(readCachedSession('k1', NOW)).toBeNull();
    expect(readCachedSession('extra', NOW)).not.toBeNull();
  });
});
