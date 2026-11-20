import { beforeEach, describe, expect, it, vi } from 'vitest';

const next = vi.hoisted(() => ({ calls: [] as Array<{ keyParts: string[]; options: { tags: string[]; revalidate: number } }>, revalidated: [] as unknown[][],
  revalidateThrows: false, missing: false }));
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...a: unknown[]) => unknown, keyParts: string[], options: { tags: string[]; revalidate: number }) => {
    next.calls.push({ keyParts, options });
    return (...args: unknown[]) => {
      if (next.missing) throw new Error('Invariant: incrementalCache missing in unstable_cache');
      return fn(...args);
    };
  },
  revalidateTag: (...args: unknown[]) => {
    if (next.revalidateThrows) throw new Error('Invariant: static generation store missing in revalidateTag');
    next.revalidated.push(args);
  },
}));

import { revalidateShop, SHOP_CACHE_SECONDS, shopCached, shopTag } from './shop-cache';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

describe('shop data cache', () => {
  beforeEach(() => { next.calls = []; next.revalidated = []; next.revalidateThrows = false; next.missing = false; });

  it('keys every entry by loader, account and handle, tags it with the shop and keeps it briefly', async () => {
    expect(await shopCached('category', A, 'shop-a', async (x: number) => x + 1, 1)).toBe(2);
    await shopCached('category', B, 'shop-b', async (x: number) => x + 1, 1);
    expect(next.calls[0]).toEqual({ keyParts: ['shop-data-v1', 'category', A, 'shop-a'], options: { tags: [`shop:${A}`], revalidate: SHOP_CACHE_SECONDS } });
    // Another shop with the same arguments never shares the entry.
    expect(next.calls[1].keyParts).toEqual(['shop-data-v1', 'category', B, 'shop-b']);
    expect(SHOP_CACHE_SECONDS).toBeGreaterThanOrEqual(60);
    expect(SHOP_CACHE_SECONDS).toBeLessThanOrEqual(120);
  });

  it('just runs the loader where there is no Next data cache (tests, worker, scripts)', async () => {
    next.missing = true;
    expect(await shopCached('home', A, 'shop-a', async () => 'fresh')).toBe('fresh');
  });

  it('passes on a loader error', async () => {
    await expect(shopCached('home', A, 'shop-a', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
  });

  it('drops one shop at once and never throws outside a request', () => {
    revalidateShop(A);
    expect(next.revalidated).toEqual([[shopTag(A), { expire: 0 }]]);
    next.revalidateThrows = true;
    expect(() => revalidateShop(B)).not.toThrow();
    revalidateShop(null);
    expect(next.revalidated).toHaveLength(1);
  });
});
