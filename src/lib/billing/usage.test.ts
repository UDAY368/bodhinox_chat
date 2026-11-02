import { describe, expect, it } from 'vitest';
import { ACTIVE_CONTACTS_CACHE_MS, meterIsFresh } from './usage';

describe('meterIsFresh', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  it('reuses a value computed within the cache window', () => {
    expect(meterIsFresh(new Date(now.getTime() - ACTIVE_CONTACTS_CACHE_MS + 1), now)).toBe(true);
    expect(meterIsFresh(now, now)).toBe(true);
  });
  it('recomputes an old, future-dated or missing value', () => {
    expect(meterIsFresh(new Date(now.getTime() - ACTIVE_CONTACTS_CACHE_MS), now)).toBe(false);
    expect(meterIsFresh(new Date(now.getTime() + 1000), now)).toBe(false);
    expect(meterIsFresh(null, now)).toBe(false);
  });
});
