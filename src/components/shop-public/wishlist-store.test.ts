import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanWishlist, readWishlist, toggleWishlist, writeWishlist, WISHLIST_LIMIT } from './wishlist-store';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('cleanWishlist', () => {
  it('keeps distinct well-formed ids and ignores everything else', () => {
    expect(cleanWishlist([A, A.toUpperCase(), B, 'nope', 4, null])).toEqual([A, B]);
    expect(cleanWishlist('x')).toEqual([]);
    expect(cleanWishlist(Array.from({ length: 80 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`))).toHaveLength(WISHLIST_LIMIT);
  });
});

describe('the browser wishlist', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      dispatchEvent: () => true,
    });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('saves and removes one variant at a time and says whether it is saved', () => {
    expect(toggleWishlist(A)).toBe(true);
    expect(toggleWishlist(B)).toBe(true);
    expect(readWishlist()).toEqual([A, B]);
    expect(toggleWishlist(A)).toBe(false);
    expect(readWishlist()).toEqual([B]);
    writeWishlist([]);
    expect(store.size).toBe(0);
  });
  it('survives a corrupt stored value and blocked storage', () => {
    store.set('bodhinox-wishlist', '{not json');
    expect(readWishlist()).toEqual([]);
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} }, dispatchEvent: () => true });
    writeWishlist([A]);
    expect(readWishlist()).toEqual([A]);
  });
});
