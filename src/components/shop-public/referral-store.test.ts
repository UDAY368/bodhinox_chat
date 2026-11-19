import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanRef, clearStoredRef, persistRef, readRef, writeRef } from './referral-store';

describe('cleanRef', () => {
  it('keeps only a well-formed code, upper-cased', () => {
    expect(cleanRef(' abcd2345 ')).toBe('ABCD2345');
    for (const bad of ['ABCD234', 'ABCD234O', 'ABCD-345', '<script>', '', null, 5]) expect(cleanRef(bad)).toBeNull();
  });
});

describe('the remembered referral code', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps one code per shop and ignores a bad one', () => {
    writeRef('shop-a', 'abcd2345');
    writeRef('shop-b', 'WXYZ6789');
    writeRef('shop-a', 'not a code');
    expect(readRef('shop-a')).toBe('ABCD2345');
    expect(readRef('shop-b')).toBe('WXYZ6789');
    expect(readRef('shop-c')).toBeNull();
  });

  it('falls back to memory when storage is blocked', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
    writeRef('shop-m', 'ABCD2345');
    expect(readRef('shop-m')).toBe('ABCD2345');
  });
});

describe('the referral code before consent', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps an undecided visitor code in memory only, then saves it on accept', () => {
    writeRef('shop-c1', 'ABCD2345', false);
    expect(readRef('shop-c1')).toBe('ABCD2345');
    expect(store.size).toBe(0);
    persistRef('shop-c1');
    expect(store.get('bodhinox-ref:shop-c1')).toBe('ABCD2345');
  });

  it('forgets a stored code on decline but keeps the code for this visit', () => {
    writeRef('shop-c2', 'ABCD2345', true);
    expect(store.size).toBe(1);
    clearStoredRef('shop-c2');
    expect(store.size).toBe(0);
    expect(readRef('shop-c2')).toBe('ABCD2345');
  });
});