import { describe, expect, it } from 'vitest';
import {
  categoryPath, firstFreeSlug, isDerivedSlug, isShopSlug, jsonLdScript, productPath, readShopKey, slugBase, slugCandidate,
} from './shop-paths';

const ID = '3f2a9c1b-0000-4000-8000-000000000001';

describe('slugBase', () => {
  it('turns a name into lower-case latin words joined by hyphens', () => {
    expect(slugBase('Neem Oil 200ml', ID)).toBe('neem-oil-200ml');
    expect(slugBase('  Café — Crème Brûlée!! ', ID)).toBe('cafe-creme-brulee');
    expect(slugBase('A/B & C', ID)).toBe('a-b-c');
  });

  it('caps the slug at 60 characters without a trailing hyphen', () => {
    const slug = slugBase(`${'word '.repeat(30)}end`, ID);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toMatch(/-$/);
    expect(isShopSlug(slug)).toBe(true);
  });

  it('falls back to the first 8 characters of the id for a name with nothing latin', () => {
    expect(slugBase('नीम तेल', ID)).toBe('3f2a9c1b');
    expect(slugBase('!!!', ID)).toBe('3f2a9c1b');
  });

  it('never gives a slug shaped like a uuid', () => {
    const slug = slugBase('0f0e5b4e 6d33 4c2c 9b8a 8a1c5c1d2e3f', ID);
    expect(readShopKey(slug)).toEqual({ slug });
    expect(isShopSlug(slug)).toBe(true);
  });
});

describe('numbering', () => {
  it('numbers repeats and keeps the number when the base is long', () => {
    expect(slugCandidate('oil', 1)).toBe('oil');
    expect(slugCandidate('oil', 3)).toBe('oil-3');
    const long = 'a'.repeat(59) + 'b';
    expect(slugCandidate(long, 12)).toHaveLength(60);
    expect(slugCandidate(long, 12)).toMatch(/-12$/);
    expect(slugCandidate('abc-'.repeat(15).slice(0, 60), 2)).not.toMatch(/--/);
  });

  it('picks the first free candidate', () => {
    expect(firstFreeSlug('oil', new Set())).toBe('oil');
    expect(firstFreeSlug('oil', new Set(['oil', 'oil-2']))).toBe('oil-3');
    expect(firstFreeSlug('oil', new Set(['oil', 'oil-2']), 2)).toBeNull();
  });

  it('knows a slug the name made from one the seller chose', () => {
    expect(isDerivedSlug('neem-oil', 'Neem Oil', ID)).toBe(true);
    expect(isDerivedSlug('neem-oil-4', 'Neem Oil', ID)).toBe(true);
    expect(isDerivedSlug('neem-oil-1', 'Neem Oil', ID)).toBe(false);
    expect(isDerivedSlug('best-oil', 'Neem Oil', ID)).toBe(false);
  });
});

describe('paths and keys', () => {
  it('builds the slug address, or the id address for a row without a slug', () => {
    expect(productPath('my-shop', { id: ID, slug: 'neem-oil' })).toBe('/s/my-shop/p/neem-oil');
    expect(productPath('my-shop', { id: ID, slug: null })).toBe(`/s/my-shop/p/${ID}`);
    expect(categoryPath('my-shop', { id: ID, slug: 'hair' })).toBe('/s/my-shop/c/hair');
    expect(categoryPath('my-shop', { id: ID })).toBe(`/s/my-shop/c/${ID}`);
  });

  it('reads an address segment as an id, a slug or nothing', () => {
    expect(readShopKey(ID.toUpperCase())).toEqual({ id: ID });
    expect(readShopKey('neem-oil')).toEqual({ slug: 'neem-oil' });
    for (const bad of ['', 'Neem', 'a--b', '../x', 'x'.repeat(61), 42, null]) expect(readShopKey(bad)).toBeNull();
  });
});

describe('jsonLdScript', () => {
  it('cannot end the script tag or open a comment, and still parses to the same value', () => {
    const value = { name: '</script><script>alert(1)</script> <!-- &   ', n: 1 };
    const text = jsonLdScript(value);
    expect(text).not.toMatch(/[<>&  ]/);
    expect(text.toLowerCase()).not.toContain('</script');
    expect(JSON.parse(text)).toEqual(value);
  });
});
