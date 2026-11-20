import { describe, expect, it } from 'vitest';
import type { PublicProduct } from './public-shop';
import { absoluteUrl, clip, productJsonLd, productListing } from './shop-seo';
import { sitemapXml } from './shop-sitemap';

const ORIGIN = 'https://app.example.test';
const product = (over: Partial<PublicProduct> = {}): PublicProduct => ({
  id: 'p1', slug: 'neem-oil', name: 'Neem Oil', description: 'Cold pressed neem oil for hair and skin.', disclosure: null,
  categoryId: 'c1', categoryName: 'Oils', categorySlug: 'oils', images: ['/api/public/store/shop/images/i1', 'https://cdn.example.test/2.jpg'],
  details: [], digital: false, rating: null,
  variants: [{ id: 'v1', options: {}, priceMinor: 25000, compareAtMinor: null, inStock: true, available: null, imageIndex: null, shipsBy: null }],
  ...over,
});
const seo: { title: string | null; description: string | null; imageUrl: string | null; sku: string | null } = { title: null, description: null, imageUrl: null, sku: 'NEEM-1' };
const input = (p = product(), s = seo) => ({ handle: 'shop', shopName: 'Green Shop', currency: 'INR', product: p, seo: s });

describe('product listing', () => {
  it('uses the seller listing first, else the name, the description and the first image', () => {
    expect(productListing(input())).toEqual({ title: 'Neem Oil', description: 'Cold pressed neem oil for hair and skin.', image: '/api/public/store/shop/images/i1' });
    expect(productListing(input(product(), { ...seo, title: 'T', description: 'D', imageUrl: '/x' }))).toEqual({ title: 'T', description: 'D', image: '/x' });
  });

  it('clips long text on a word', () => {
    const text = clip('word '.repeat(60), 160)!;
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith('…')).toBe(true);
    expect(clip('   ', 160)).toBeUndefined();
  });

  it('makes site paths absolute and leaves full URLs alone', () => {
    expect(absoluteUrl('/s/shop', ORIGIN)).toBe(`${ORIGIN}/s/shop`);
    expect(absoluteUrl('https://cdn.example.test/2.jpg', ORIGIN)).toBe('https://cdn.example.test/2.jpg');
    expect(absoluteUrl('/s/shop', undefined)).toBe('/s/shop');
  });
});

describe('productJsonLd', () => {
  it('describes the product, its offer, SKU and breadcrumb with absolute slug addresses', () => {
    const [ld, crumbs] = productJsonLd(input(), ORIGIN) as [Record<string, any>, Record<string, any>];
    expect(ld).toMatchObject({
      '@type': 'Product', name: 'Neem Oil', url: `${ORIGIN}/s/shop/p/neem-oil`, sku: 'NEEM-1',
      image: [`${ORIGIN}/api/public/store/shop/images/i1`, 'https://cdn.example.test/2.jpg'],
      offers: { '@type': 'Offer', price: '250.00', priceCurrency: 'INR', availability: 'https://schema.org/InStock' },
    });
    expect(ld.aggregateRating).toBeUndefined();
    expect(crumbs.itemListElement.map((c: { item: string }) => c.item)).toEqual([`${ORIGIN}/s/shop`, `${ORIGIN}/s/shop/c/oils`, `${ORIGIN}/s/shop/p/neem-oil`]);
  });

  it('gives a price range, out of stock and a rating when they apply', () => {
    const p = product({
      rating: { average: 4.5, count: 12 },
      variants: [
        { id: 'a', options: {}, priceMinor: 10000, compareAtMinor: null, inStock: false, available: 0, imageIndex: null, shipsBy: null },
        { id: 'b', options: {}, priceMinor: 30000, compareAtMinor: null, inStock: false, available: 0, imageIndex: null, shipsBy: null },
      ],
    });
    const [ld] = productJsonLd(input(p), ORIGIN) as [Record<string, any>];
    expect(ld.offers).toMatchObject({ '@type': 'AggregateOffer', lowPrice: '100.00', highPrice: '300.00', availability: 'https://schema.org/OutOfStock', offerCount: 2 });
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 4.5, reviewCount: 12 });
  });
});

describe('sitemapXml', () => {
  it('escapes addresses and writes lastmod', () => {
    const xml = sitemapXml([{ path: '/s/shop' }, { path: '/s/shop/p/a&b', lastModified: '2026-11-19T00:00:00.000Z' }], ORIGIN);
    expect(xml).toContain(`<loc>${ORIGIN}/s/shop</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/s/shop/p/a&amp;b</loc><lastmod>2026-11-19T00:00:00.000Z</lastmod>`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});
