import { describe, expect, it } from 'vitest';
import {
  htmlToText, mapShopifyProduct, mapWooProduct, MAX_BACKOFF_MS, MAX_FETCH_ATTEMPTS, nextWooPage, parseShopifyPage, planPlatformRows, parseWooList, PlatformError,
  retryAfterMs, retryDecision, shopifyRequestBody, toImportRows, wooAuthHeader, wooProductsUrl, WOO_PAGE, type SourceProduct,
} from './platform-import';

// Fixtures shaped like the platforms' real answers (fields trimmed to what the importer reads).
const shopifyNode = {
  id: 'gid://shopify/Product/9001', title: ' Neem Oil ', descriptionHtml: '<p>Cold&nbsp;pressed &amp; pure</p><p>Second<br>line</p><script>x()</script>',
  vendor: 'Bodhi', productType: 'Oils', tags: ['Organic', ' organic ', 'Hair', 'x'.repeat(41)],
  images: { nodes: [{ url: 'https://cdn.shopify.com/a.jpg' }, { url: 'http://insecure.example/b.jpg' }, { url: 'https://u:p@evil.example/c.jpg' }, { url: 'https://cdn.shopify.com/a.jpg' }] },
  variants: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { id: 'gid://shopify/ProductVariant/11', sku: 'NEEM-100', price: '199.00', compareAtPrice: '249.000', inventoryQuantity: 7, selectedOptions: [{ name: 'Size', value: '100ml' }], inventoryItem: { tracked: true } },
      { id: 'gid://shopify/ProductVariant/12', sku: '', price: '349.50', compareAtPrice: null, inventoryQuantity: -3, selectedOptions: [{ name: 'Size', value: '250ml' }], inventoryItem: { tracked: false } },
    ],
  },
};
const wooSimple = { id: 55, type: 'simple', name: 'Soap', sku: 'SOAP-1', description: '<p>Bar</p>', regular_price: '120', sale_price: '99', manage_stock: true, stock_quantity: 4,
  tags: [{ name: 'Bath' }], categories: [{ name: 'Soaps' }], images: [{ src: 'https://shop.example/s.jpg' }], attributes: [] };
const wooVariable = { id: 70, type: 'variable', name: 'Tee', sku: '', description: '', images: [], tags: [], categories: [] };
const wooVariations = [
  { id: 701, sku: 'TEE-S', regular_price: '500', sale_price: '', manage_stock: true, stock_quantity: 2, attributes: [{ name: 'Size', option: 'S' }] },
  { id: 702, sku: '', regular_price: '500', sale_price: '', manage_stock: false, attributes: [{ name: 'Size', option: 'M' }] },
];

describe('Shopify mapping', () => {
  it('maps a product, its variants and a synthetic SKU for a variant without one', () => {
    const p = mapShopifyProduct(shopifyNode)!;
    expect(p).toMatchObject({ sourceId: '9001', name: 'Neem Oil', brand: 'Bodhi', productType: 'Oils', tags: ['organic', 'hair'] });
    expect(p.description).toBe('Cold pressed & pure\nSecond\nline');
    expect(p.imageUrls).toEqual(['https://cdn.shopify.com/a.jpg']);
    expect(p.variants.map((v) => [v.sku, v.fallbackSku, v.options])).toEqual([['NEEM-100', 'SHOPIFY-11', { Size: '100ml' }], [null, 'SHOPIFY-12', { Size: '250ml' }]]);
    const m = toImportRows(p, 3, 'INR');
    expect(m.errors).toEqual([]);
    expect(m.rows.map((r) => [r.sku, r.priceMinor, r.compareAtMinor, r.stock, r.trackInventory])).toEqual([
      ['NEEM-100', 19900, 24900, 7, true], ['SHOPIFY-12', 34950, undefined, undefined, false]]);
    expect(m.rows[0]).toMatchObject({ name: 'Neem Oil', brand: 'Bodhi', rowNumber: 3 });
    expect(m.rows[1].name).toBeUndefined(); // product fields ride on the first row only
    expect(m.rows.every((r) => r.status === undefined)).toBe(true); // never published by an import
  });

  it('drops the placeholder option of a product without options', () => {
    const p = mapShopifyProduct({ ...shopifyNode, variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', price: '1', selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] } })!;
    expect(p.variants[0].options).toEqual({});
  });

  it('refuses a product with no id and reports rows it cannot price, without echoing content', () => {
    expect(mapShopifyProduct({ title: 'x' })).toBeNull();
    const p = mapShopifyProduct({ ...shopifyNode, variants: { pageInfo: { hasNextPage: true }, nodes: [
      { id: 'gid://shopify/ProductVariant/1', sku: 'A', price: 'abc' }, { id: 'gid://shopify/ProductVariant/2', sku: 'B' }, { id: 'gid://shopify/ProductVariant/3', sku: 'C', price: '5' }] } })!;
    const m = toImportRows(p, 9, 'INR');
    expect(m.rows.map((r) => r.sku)).toEqual(['C']);
    expect(m.errors).toEqual([{ row: 9, field: 'variants', code: 'variants_truncated' }, { row: 9, field: 'price', code: 'invalid' }, { row: 9, field: 'price', code: 'required' }]);
    expect(JSON.stringify(m.errors)).not.toContain('Neem');
  });

  it('skips a product with no variants or before the store currency is set', () => {
    expect(toImportRows({ ...mapShopifyProduct(shopifyNode)!, variants: [] }, 1, 'INR')).toMatchObject({ skipped: true, errors: [{ code: 'no_variants' }] });
    expect(toImportRows(mapShopifyProduct(shopifyNode)!, 1, null)).toMatchObject({ skipped: true, errors: [{ code: 'store_not_configured' }] });
  });
});

describe('Shopify pages and cursors', () => {
  it('reads the next cursor only while there is a next page', () => {
    const body = (hasNextPage: boolean) => JSON.stringify({ data: { products: { pageInfo: { hasNextPage, endCursor: 'abc==' }, nodes: [shopifyNode] } } });
    expect(parseShopifyPage(body(true))).toMatchObject({ next: 'abc==', throttled: false, products: [{ sourceId: '9001' }] });
    expect(parseShopifyPage(body(false)).next).toBeNull();
  });

  it('puts the cursor into the next request and nothing else of the secret kind', () => {
    expect(JSON.parse(shopifyRequestBody(null)).variables).toMatchObject({ after: null });
    expect(JSON.parse(shopifyRequestBody('abc==')).variables).toMatchObject({ after: 'abc==', first: 10 });
  });

  it('tells a throttle from a refused scope from rubbish', () => {
    const err = (code: string) => JSON.stringify({ errors: [{ message: 'm', extensions: { code } }] });
    expect(parseShopifyPage(err('THROTTLED')).throttled).toBe(true);
    expect(() => parseShopifyPage(err('ACCESS_DENIED'))).toThrowError(expect.objectContaining({ code: 'scope_missing' }));
    expect(() => parseShopifyPage('<html>')).toThrowError(expect.objectContaining({ code: 'bad_response' }));
  });
});

describe('WooCommerce mapping and pages', () => {
  it('maps a simple product with a sale price as price plus compare-at', () => {
    const p = mapWooProduct({ product: wooSimple, variations: [] })!;
    expect(p).toMatchObject({ sourceId: '55', name: 'Soap', productType: 'Soaps', tags: ['bath'], imageUrls: ['https://shop.example/s.jpg'] });
    const m = toImportRows(p, 1, 'INR');
    expect(m.rows[0]).toMatchObject({ sku: 'SOAP-1', priceMinor: 9900, compareAtMinor: 12000, stock: 4, trackInventory: true });
  });

  it('maps variations with option values, fallback SKUs and untracked stock', () => {
    const p = mapWooProduct({ product: { ...wooVariable, name: 'Tee', regular_price: '' }, variations: wooVariations })!;
    const m = toImportRows(p, 2, 'INR');
    expect(m.rows.map((r) => [r.sku, r.options, r.priceMinor, r.trackInventory, r.stock])).toEqual([
      ['TEE-S', { Size: 'S' }, 50000, true, 2], ['WOO-70-702', { Size: 'M' }, 50000, false, undefined]]);
  });

  it('maps a grouped product to no variants (it has no price of its own)', () => {
    const p = mapWooProduct({ product: { ...wooSimple, type: 'grouped' }, variations: [] })!;
    expect(toImportRows(p, 1, 'INR').skipped).toBe(true);
  });

  it('paginates: a full page means another, a short page is the last', () => {
    expect(nextWooPage(1, WOO_PAGE)).toBe(2);
    expect(nextWooPage(4, WOO_PAGE - 1)).toBeNull();
    expect(nextWooPage(1, 0)).toBeNull();
    expect(wooProductsUrl('https://s.example/shop/', 3)).toBe(`https://s.example/shop/wp-json/wc/v3/products?per_page=${WOO_PAGE}&page=3&orderby=id&order=asc&status=any`);
  });

  it('builds a Basic header from the key and refuses a body that is not a list', () => {
    expect(wooAuthHeader('ck_a', 'cs_b')).toBe(`Basic ${Buffer.from('ck_a:cs_b').toString('base64')}`);
    expect(() => parseWooList('{"code":"woocommerce_rest_cannot_view"}')).toThrow(PlatformError);
    expect(parseWooList('[{"id":1}]')).toHaveLength(1);
  });
});

describe('retry and back-off decisions', () => {
  it('retries rate limits and server trouble with Retry-After or exponential delay, capped', () => {
    expect(retryDecision(429, 1, '3')).toEqual({ retry: true, delayMs: 3000 });
    expect(retryDecision(503, 1)).toEqual({ retry: true, delayMs: 1000 });
    expect(retryDecision(503, 3)).toEqual({ retry: true, delayMs: 4000 });
    expect(retryDecision(0, 2)).toEqual({ retry: true, delayMs: 2000 });
    expect(retryDecision(429, 2, '9999')).toEqual({ retry: true, delayMs: MAX_BACKOFF_MS });
    expect(retryDecision(429, 1, 'Wed, 21 Oct 2026 07:28:00 GMT')).toEqual({ retry: true, delayMs: 1000 });
  });
  it('gives up after the attempt limit, with the matching code', () => {
    expect(retryDecision(429, MAX_FETCH_ATTEMPTS)).toEqual({ retry: false, code: 'rate_limited' });
    expect(retryDecision(502, MAX_FETCH_ATTEMPTS)).toEqual({ retry: false, code: 'unreachable' });
  });
  it('does not retry a refused login, a missing scope or a missing store', () => {
    expect(retryDecision(401, 1)).toEqual({ retry: false, code: 'unauthorized' });
    expect(retryDecision(403, 1)).toEqual({ retry: false, code: 'scope_missing' });
    expect(retryDecision(404, 1)).toEqual({ retry: false, code: 'not_found' });
    expect(retryDecision(400, 1)).toEqual({ retry: false, code: 'http_error' });
    expect(retryAfterMs('0.5')).toBe(500);
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe('planning page rows', () => {
  const src = (sourceId: string, skus: string[]): { product: SourceProduct; rows: ReturnType<typeof toImportRows>['rows']; row: number } => {
    const product: SourceProduct = { sourceId, name: `P${sourceId}`, description: null, brand: null, productType: null, tags: [], imageUrls: [], variantsTruncated: false,
      variants: skus.map((sku) => ({ sku, fallbackSku: `F-${sku}`, options: {}, price: '1', compareAt: null, stock: null, tracked: null })) };
    return { product, rows: toImportRows(product, 1, 'INR').rows, row: Number(sourceId) };
  };

  it('groups a new product by its source id, never by its name', () => {
    const a = src('1', ['A1', 'A2']);
    const b = { ...src('2', ['B1']), product: { ...src('2', ['B1']).product, name: 'P1' } };
    const { planned } = planPlatformRows('shopify', [a, b], new Map());
    expect(planned.map((p) => [p.row.sku, p.key, p.first, p.last])).toEqual([
      ['A1', 'n:shopify:1', true, false], ['A2', 'n:shopify:1', false, true], ['B1', 'n:shopify:2', true, true]]);
  });

  it('points a known SKU at its existing product and flags a SKU owned by another product or repeated', () => {
    const existing = new Map([['A1', { productId: 'prod-1', variantId: 'var-1' }], ['Z9', { productId: 'prod-9', variantId: 'var-9' }]]);
    const { planned, errors } = planPlatformRows('woocommerce', [src('1', ['A1', 'A2', 'Z9']), src('2', ['A2'])], existing);
    expect(planned.map((p) => [p.row.sku, p.kind, p.key])).toEqual([['A1', 'update', 'p:prod-1'], ['A2', 'create', 'p:prod-1']]);
    expect(errors).toEqual([{ row: 1, field: 'sku', code: 'sku_conflict' }, { row: 2, field: 'sku', code: 'duplicate_sku' }]);
  });
});

describe('htmlToText', () => {
  it('strips tags and scripts and decodes common entities', () => {
    expect(htmlToText('<div>A &lt;b&gt; &#39;q&#39;</div>')).toBe("A <b> 'q'");
    expect(htmlToText('<style>p{}</style>')).toBeNull();
    expect(htmlToText(null)).toBeNull();
  });
});
