import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConsent, writeConsent } from './consent-store';
import { shopPathOf } from './live-beacon';

describe('the optional-storage choice', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is undecided until the visitor chooses, then remembered per shop', () => {
    expect(readConsent('shop-a')).toBeNull();
    writeConsent('shop-a', 'no');
    writeConsent('shop-b', 'yes');
    expect(readConsent('shop-a')).toBe('no');
    expect(readConsent('shop-b')).toBe('yes');
  });

  it('ignores a tampered stored value and survives blocked storage for the visit', () => {
    store.set('bodhinox-consent:shop-c', 'maybe');
    expect(readConsent('shop-c')).toBeNull();
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    writeConsent('shop-d', 'yes');
    expect(readConsent('shop-d')).toBe('yes');
  });
});

describe('the live beacon path', () => {
  it('sends the path under the shop and nothing else', () => {
    expect(shopPathOf('/s/kumar', 'kumar')).toBe('/');
    expect(shopPathOf('/s/kumar/p/abc', 'kumar')).toBe('/p/abc');
    expect(shopPathOf('/elsewhere', 'kumar')).toBe('/');
  });
});
