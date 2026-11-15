/**
 * Import from a Shopify or WooCommerce store, the pure part (no database, no network): the request
 * builders, the page parsers and cursors, the mapping of platform product JSON to the same ImportRow
 * shape the CSV import applies, and the retry decision. platform-import-job.ts runs it.
 *
 * Nothing here logs or returns a credential, and a row error names the row, the field and a code only
 * (never a title or any other product content). Imported products carry no status, so a new product
 * is a draft and an existing one keeps its status.
 */
import { currencyExponent, MoneyError, parseMoney } from '../money';
import { MAX_IMAGES, parseOptionValues, parseTags, SKU } from './products';
import type { ExistingSku, ImportRow, PlannedRow, RowError } from './product-csv';

export type Platform = 'shopify' | 'woocommerce';
export const MAX_IMPORT_PRODUCTS = 5000;
export const SHOPIFY_PAGE = 10;
export const SHOPIFY_VARIANTS = 30;
export const WOO_PAGE = 25;
export const WOO_VARIATIONS_PAGE = 100;
export const WOO_VARIATION_PAGES = 5;

/** One product as the platform sent it, reduced to what the catalogue stores. */
export interface SourceVariant {
  sku: string | null;
  /** Fallback SKU when the platform has none (stable per variant, so a replay matches it). */
  fallbackSku: string;
  options: Record<string, string>;
  price: string | null;
  compareAt: string | null;
  /** null = the platform does not track stock for it. */
  stock: number | null;
  tracked: boolean | null;
}
export interface SourceProduct {
  sourceId: string;
  name: string;
  description: string | null;
  brand: string | null;
  productType: string | null;
  tags: string[];
  imageUrls: string[];
  variants: SourceVariant[];
  /** The platform had more variants than one page returned. */
  variantsTruncated: boolean;
}

// ------------------------------------------------------------ small helpers

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const CONTROL = /[\u0000-\u001f\u007f]/;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#039': "'" };

/** Platform HTML to plain text: block ends become new lines, tags go, the common entities decode. Linear-time. */
export function htmlToText(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>|<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, 5000) : null;
}

function cleanTags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  for (const t of raw) {
    const tag = typeof t === 'string' ? t.trim().toLowerCase() : '';
    if (tag && tag.length <= 40 && !CONTROL.test(tag)) seen.add(tag);
  }
  const list = [...seen].slice(0, 20);
  try { return parseTags(list); } catch { return []; }
}

function cleanLine(value: unknown, max: number): string | null {
  const text = str(value)?.replace(/\s+/g, ' ').trim() ?? '';
  return text && text.length <= max && !CONTROL.test(text) ? text : null;
}

/** https image URLs only, without credentials, at most MAX_IMAGES, each at most 2048 characters. */
export function cleanImageUrls(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const u = str(item)?.trim();
    if (!u || u.length > 2048) continue;
    try {
      const p = new URL(u);
      if (p.protocol === 'https:' && !p.username && !p.password && !out.includes(u)) out.push(u);
    } catch { /* not a URL */ }
    if (out.length === MAX_IMAGES) break;
  }
  return out;
}

const numericTail = (id: string) => /(\d{1,20})$/.exec(id)?.[1] ?? null;

function cleanOptions(pairs: [string, string][]): Record<string, string> {
  const named = pairs.filter(([k, v]) => k.trim() && v.trim());
  // A single "Title: Default Title" option is Shopify's placeholder for a product without options.
  if (named.length === 1 && named[0][1] === 'Default Title') return {};
  try { return parseOptionValues(Object.fromEntries(named)); } catch { return {}; }
}

// ------------------------------------------------------------ Shopify

export const SHOPIFY_QUERY = `query ProductsPage($first: Int!, $after: String, $variants: Int!) {
  products(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title descriptionHtml vendor productType tags
      images(first: 10) { nodes { url } }
      variants(first: $variants) {
        pageInfo { hasNextPage }
        nodes { id sku price compareAtPrice inventoryQuantity selectedOptions { name value } inventoryItem { tracked } }
      }
    }
  }
}`;

export function shopifyRequestBody(cursor: string | null): string {
  return JSON.stringify({ query: SHOPIFY_QUERY, variables: { first: SHOPIFY_PAGE, after: cursor, variants: SHOPIFY_VARIANTS } });
}

export interface ShopifyPage { products: SourceProduct[]; next: string | null; throttled: boolean }

/** A GraphQL response body to products and the next cursor. Throws PlatformError for a refusal that no retry fixes. */
export function parseShopifyPage(body: string): ShopifyPage {
  let json: Record<string, unknown>;
  try { json = rec(JSON.parse(body)); } catch { throw new PlatformError('bad_response'); }
  const errors = arr(json.errors).map(rec);
  if (errors.length) {
    const codes = errors.map((e) => String(rec(e.extensions).code ?? ''));
    if (codes.includes('THROTTLED')) return { products: [], next: null, throttled: true };
    if (codes.includes('ACCESS_DENIED')) throw new PlatformError('scope_missing');
    throw new PlatformError('bad_response');
  }
  const products = rec(rec(json.data).products);
  const info = rec(products.pageInfo);
  const next = info.hasNextPage === true && typeof info.endCursor === 'string' && info.endCursor ? info.endCursor : null;
  return { products: arr(products.nodes).map(mapShopifyProduct).filter((p): p is SourceProduct => p !== null), next, throttled: false };
}

export function mapShopifyProduct(node: unknown): SourceProduct | null {
  const n = rec(node);
  const id = str(n.id) ? numericTail(String(n.id)) : null;
  if (!id) return null;
  const variantsConn = rec(n.variants);
  const variants = arr(variantsConn.nodes).map(rec).flatMap((v): SourceVariant[] => {
    const vid = str(v.id) ? numericTail(String(v.id)) : null;
    if (!vid) return [];
    const tracked = typeof rec(v.inventoryItem).tracked === 'boolean' ? (rec(v.inventoryItem).tracked as boolean) : null;
    const qty = typeof v.inventoryQuantity === 'number' && Number.isFinite(v.inventoryQuantity) ? Math.max(0, Math.trunc(v.inventoryQuantity)) : null;
    const sku = str(v.sku)?.trim() ?? '';
    return [{
      sku: sku || null,
      fallbackSku: `SHOPIFY-${vid}`,
      options: cleanOptions(arr(v.selectedOptions).map(rec).map((o) => [str(o.name) ?? '', str(o.value) ?? ''])),
      price: str(v.price), compareAt: str(v.compareAtPrice),
      stock: qty, tracked,
    }];
  });
  return {
    sourceId: id,
    name: str(n.title)?.trim() ?? '',
    description: htmlToText(str(n.descriptionHtml)),
    brand: cleanLine(n.vendor, 80),
    productType: cleanLine(n.productType, 80),
    tags: cleanTags(arr(n.tags)),
    imageUrls: cleanImageUrls(arr(rec(n.images).nodes).map((i) => rec(i).url)),
    variants,
    variantsTruncated: rec(variantsConn.pageInfo).hasNextPage === true,
  };
}

// ------------------------------------------------------------ WooCommerce

/** The REST URL of a products page. `storeUrl` is a registered https store URL. */
export function wooProductsUrl(storeUrl: string, page: number): string {
  return `${storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/products?per_page=${WOO_PAGE}&page=${page}&orderby=id&order=asc&status=any`;
}
export function wooVariationsUrl(storeUrl: string, productId: string, page: number): string {
  return `${storeUrl.replace(/\/+$/, '')}/wp-json/wc/v3/products/${encodeURIComponent(productId)}/variations?per_page=${WOO_VARIATIONS_PAGE}&page=${page}`;
}
export const wooAuthHeader = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

/** The page number after `page`: null when this page was the last (short or empty). */
export function nextWooPage(page: number, received: number): number | null {
  return received >= WOO_PAGE ? page + 1 : null;
}

export interface WooRaw { product: Record<string, unknown>; variations: Record<string, unknown>[] }

/** A products page body to its product objects (throws bad_response when it is not a JSON array). */
export function parseWooList(body: string): Record<string, unknown>[] {
  try {
    const json: unknown = JSON.parse(body);
    if (!Array.isArray(json)) throw new Error('not a list');
    return json.map(rec);
  } catch { throw new PlatformError('bad_response'); }
}

const wooPrice = (v: unknown) => { const s = str(v)?.trim(); return s ? s : null; };

function wooVariant(parentId: string, id: string | null, v: Record<string, unknown>, options: [string, string][], parentIsVariation: boolean): SourceVariant {
  const regular = wooPrice(v.regular_price) ?? wooPrice(v.price);
  const sale = wooPrice(v.sale_price);
  const manage = v.manage_stock === true || v.manage_stock === 'parent';
  const qty = typeof v.stock_quantity === 'number' ? Math.max(0, Math.trunc(v.stock_quantity)) : null;
  return {
    sku: str(v.sku)?.trim() || null,
    fallbackSku: parentIsVariation && id ? `WOO-${parentId}-${id}` : `WOO-${parentId}`,
    options: cleanOptions(options),
    price: sale ? sale : regular, compareAt: sale ? regular : null,
    stock: manage ? qty ?? 0 : null, tracked: manage,
  };
}

/** One WooCommerce product (with its variations when it is a variable product). Grouped products have no price and map to no variant. */
export function mapWooProduct({ product: p, variations }: WooRaw): SourceProduct | null {
  const id = str(p.id);
  if (!id || !/^\d{1,20}$/.test(id)) return null;
  const type = str(p.type) ?? 'simple';
  const brands = arr(p.brands).map((b) => rec(b).name);
  const categories = arr(p.categories).map((c) => rec(c).name);
  let list: SourceVariant[] = [];
  if (type === 'variable') {
    list = variations.map((v) => wooVariant(id, str(v.id), v,
      arr(v.attributes).map(rec).map((a): [string, string] => [str(a.name) ?? '', str(a.option) ?? '']).filter(([, o]) => o), true));
  } else if (type !== 'grouped') {
    list = [wooVariant(id, null, p, [], false)];
  }
  return {
    sourceId: id,
    name: str(p.name)?.trim() ?? '',
    description: htmlToText(str(p.description)) ?? htmlToText(str(p.short_description)),
    brand: cleanLine(brands[0], 80),
    productType: cleanLine(categories[0], 80),
    tags: cleanTags(arr(p.tags).map((t) => rec(t).name)),
    imageUrls: cleanImageUrls(arr(p.images).map((i) => rec(i).src)),
    variants: list,
    variantsTruncated: false,
  };
}

// ------------------------------------------------------------ to import rows

function money(text: string | null, currency: string): number | null {
  if (text === null) return null;
  // "19.990" and "19.0" are the same amount: drop zeros past the currency's decimals before parsing.
  const exponent = currencyExponent(currency);
  const trimmed = text.trim().replace(/^([^.]*\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const dot = trimmed.indexOf('.');
  const clipped = dot >= 0 && trimmed.length - dot - 1 > exponent ? trimmed.slice(0, dot + 1 + exponent) : trimmed;
  return parseMoney(clipped, currency);
}

/** A source product with its mapped rows, ready for planning. `row` is the product's place in the import. */
export interface ImportRowsInput { product: SourceProduct; rows: ImportRow[]; row: number }

export interface MappedProduct { rows: ImportRow[]; errors: RowError[]; skipped: boolean }

/**
 * A source product to import rows (one per variant), all numbered `firstRow` (the product's place in the import, which is what an error shows). A variant without a
 * usable SKU gets a stable synthetic one. The product-level fields ride on the first row. A product
 * with no variant, no name, or no price in the store currency is reported and skipped, never guessed.
 */
export function toImportRows(p: SourceProduct, firstRow: number, currency: string | null): MappedProduct {
  const errors: RowError[] = [];
  const row = firstRow;
  if (!p.name || p.name.length > 200 || CONTROL.test(p.name)) return { rows: [], errors: [{ row, field: 'name', code: 'invalid' }], skipped: true };
  if (!p.variants.length) return { rows: [], errors: [{ row, field: 'variants', code: 'no_variants' }], skipped: true };
  if (!currency) return { rows: [], errors: [{ row, field: 'price', code: 'store_not_configured' }], skipped: true };
  if (p.variantsTruncated) errors.push({ row, field: 'variants', code: 'variants_truncated' });
  const rows: ImportRow[] = [];
  const used = new Set<string>();
  for (const v of p.variants) {
    const rowNumber = firstRow;
    const sku = v.sku && SKU.test(v.sku) ? v.sku : v.fallbackSku;
    if (!SKU.test(sku) || used.has(sku)) { errors.push({ row: rowNumber, field: 'sku', code: used.has(sku) ? 'duplicate_sku' : 'invalid' }); continue; }
    const out: ImportRow = { rowNumber, sku };
    let ok = true;
    for (const [field, key, text] of [['price', 'priceMinor', v.price], ['compare_at_price', 'compareAtMinor', v.compareAt]] as const) {
      try {
        const minor = money(text, currency);
        if (minor !== null) out[key] = minor;
      } catch (e) {
        if (!(e instanceof MoneyError)) throw e;
        errors.push({ row: rowNumber, field, code: 'invalid' });
        ok = false;
      }
    }
    if (!ok) continue;
    if (out.priceMinor === undefined) { errors.push({ row: rowNumber, field: 'price', code: 'required' }); continue; }
    if (out.compareAtMinor !== undefined && out.compareAtMinor <= out.priceMinor) delete out.compareAtMinor;
    if (Object.keys(v.options).length) out.options = v.options;
    if (v.tracked !== null) {
      out.trackInventory = v.tracked;
      if (v.tracked && v.stock !== null) out.stock = v.stock;
    }
    if (rows.length === 0) {
      out.name = p.name;
      if (p.description) out.description = p.description;
      if (p.tags.length) out.tags = p.tags;
      if (p.brand) out.brand = p.brand;
      if (p.productType) out.productType = p.productType;
      if (p.imageUrls.length) out.imageUrls = p.imageUrls;
    }
    used.add(sku);
    rows.push(out);
  }
  return { rows, errors, skipped: rows.length === 0 };
}

// ------------------------------------------------------------ planning

/** Source products to planned rows: matched by SKU (an existing variant keeps its product), else a new product per source id. */
export function planPlatformRows(platform: Platform, items: ImportRowsInput[], existing: ReadonlyMap<string, ExistingSku>): { planned: PlannedRow[]; errors: RowError[] } {
  const planned: PlannedRow[] = [];
  const errors: RowError[] = [];
  const claimed = new Set<string>();
  for (const { product, rows, row } of items) {
    const key = (() => {
      const hit = rows.map((r) => existing.get(r.sku)).find((e) => e);
      return hit ? `p:${hit.productId}` : `n:${platform}:${product.sourceId}`;
    })();
    const group: PlannedRow[] = [];
    for (const r of rows) {
      const e = existing.get(r.sku);
      if (claimed.has(r.sku) || (e && `p:${e.productId}` !== key)) {
        errors.push({ row, field: 'sku', code: claimed.has(r.sku) ? 'duplicate_sku' : 'sku_conflict' });
        continue;
      }
      claimed.add(r.sku);
      group.push({ row: r, kind: e ? 'update' : 'create', key, first: false, last: false, patch: {} });
    }
    if (!group.length) continue;
    group[0].first = true;
    group[group.length - 1].last = true;
    const lead = group[0].row;
    group[0].patch = { name: lead.name ?? product.name, description: lead.description, tags: lead.tags, brand: lead.brand, productType: lead.productType, imageUrls: lead.imageUrls };
    planned.push(...group);
  }
  return { planned, errors };
}

// ------------------------------------------------------------ failures and retries

export type PlatformErrorCode = 'not_connected' | 'scope_missing' | 'unauthorized' | 'not_found' | 'blocked' | 'bad_response' | 'unreachable'
  | 'rate_limited' | 'http_error' | 'woo_https_required';
export class PlatformError extends Error {
  constructor(readonly code: PlatformErrorCode) {
    super(code);
    this.name = 'PlatformError';
  }
}

export const MAX_FETCH_ATTEMPTS = 5;
export const MAX_BACKOFF_MS = 30_000;

export type RetryDecision = { retry: true; delayMs: number } | { retry: false; code: PlatformErrorCode };

/** Seconds from a Retry-After header (a number of seconds), else null. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header || !/^\d{1,5}(\.\d+)?$/.test(header.trim())) return null;
  return Math.round(Number(header) * 1000);
}

/**
 * What to do after an HTTP answer (status 0 = no answer: timeout or network). Rate limits and server
 * trouble retry with the platform's Retry-After, else an exponential delay, never past MAX_BACKOFF_MS
 * and MAX_FETCH_ATTEMPTS; a refused login or a missing store does not retry.
 */
export function retryDecision(status: number, attempt: number, retryAfter?: string | null): RetryDecision {
  const transient = status === 0 || status === 429 || status === 408 || status >= 500;
  if (!transient) {
    if (status === 401) return { retry: false, code: 'unauthorized' };
    if (status === 402 || status === 403) return { retry: false, code: status === 403 ? 'scope_missing' : 'unauthorized' };
    if (status === 404) return { retry: false, code: 'not_found' };
    return { retry: false, code: 'http_error' };
  }
  if (attempt >= MAX_FETCH_ATTEMPTS) return { retry: false, code: status === 429 ? 'rate_limited' : 'unreachable' };
  const exponential = 1000 * 2 ** (attempt - 1);
  return { retry: true, delayMs: Math.min(retryAfterMs(retryAfter) ?? exponential, MAX_BACKOFF_MS) };
}
