import { describe, expect, it } from 'vitest';
import { decodeListCursor, encodeListCursor, toPublicProduct, type LoadedProduct } from './shop-products';
import { imageSrcSet, readImageWidth, shopImageUrl, themeImageUrl } from './shop-images';

const ID = '11111111-1111-4111-8111-111111111111';

describe('list cursor (keyset paging)', () => {
  it('round-trips the sort key, name and id of the last product on a page', () => {
    const cursor = { sort: 'price_desc' as const, key: 129_900, name: 'Tulsi drops, 30 ml', id: ID };
    expect(decodeListCursor(encodeListCursor(cursor), 'price_desc')).toEqual(cursor);
    const newest = { sort: 'newest' as const, key: 1_763_700_000_123_456, name: '', id: ID };
    expect(decodeListCursor(encodeListCursor(newest), 'newest')).toEqual(newest);
  });
  it('ignores a cursor of another sort: the first page of the new sort', () => {
    expect(decodeListCursor(encodeListCursor({ sort: 'name', key: 0, name: 'a', id: ID }), 'featured')).toBeNull();
  });
  it.each([
    [undefined], [null], [''], [42], ['not base64 json'], [Buffer.from('["featured",1,"a"]').toString('base64url')],
    [Buffer.from(JSON.stringify(['featured', 1.5, 'a', ID])).toString('base64url')],
    [Buffer.from(JSON.stringify(['featured', '1', 'a', ID])).toString('base64url')],
    [Buffer.from(JSON.stringify(['featured', 1, 'a', 'not-a-uuid'])).toString('base64url')],
    [Buffer.from(JSON.stringify(['featured', 1, 7, ID])).toString('base64url')],
    [Buffer.from(JSON.stringify(['featured', 2 ** 60, 'a', ID])).toString('base64url')],
    ['x'.repeat(501)],
  ])('ignores a cursor it did not make: %j', (value) => {
    expect(decodeListCursor(value, 'featured')).toBeNull();
  });
});

describe('the public card shape', () => {
  it('leaves SKUs out', () => {
    const loaded: LoadedProduct = { id: ID, slug: 's', name: 'n', description: null, disclosure: null, categoryId: null, categoryName: null, categorySlug: null,
      images: [], details: [], digital: false, rating: null,
      variants: [{ id: ID, sku: 'SECRET-SKU', options: {}, priceMinor: 100, compareAtMinor: null, inStock: true, imageIndex: null, available: null, shipsBy: null }] };
    expect(JSON.stringify(toPublicProduct(loaded))).not.toContain('SECRET-SKU');
  });
});

describe('shop image addresses', () => {
  it('builds the product and theme image routes, and leaves an https URL as it is', () => {
    expect(shopImageUrl('my-shop', ID)).toBe(`/api/public/store/my-shop/images/${ID}`);
    expect(themeImageUrl('my-shop', `media:${ID}`)).toBe(`/api/public/store/my-shop/media/${ID}`);
    expect(themeImageUrl('my-shop', 'https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(themeImageUrl('my-shop', null)).toBeNull();
  });
  it('offers widths only for our own routes', () => {
    expect(imageSrcSet(shopImageUrl('my-shop', ID))).toBe(
      `/api/public/store/my-shop/images/${ID}?w=320 320w, /api/public/store/my-shop/images/${ID}?w=640 640w, /api/public/store/my-shop/images/${ID}?w=1080 1080w`);
    expect(imageSrcSet('https://cdn.example.com/a.png')).toBeUndefined();
    expect(imageSrcSet('/api/media/object?bucket=chat-media&key=x')).toBeUndefined();
    expect(imageSrcSet(null)).toBeUndefined();
  });
  it('reads only the known widths', () => {
    expect(readImageWidth('640')).toBe(640);
    expect(readImageWidth('641')).toBeNull();
    expect(readImageWidth('0640')).toBeNull();
    expect(readImageWidth(null)).toBeNull();
    expect(readImageWidth('1e3')).toBeNull();
  });
});
