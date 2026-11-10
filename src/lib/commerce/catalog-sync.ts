/**
 * Worker job 'commerce.catalog_sync': mirrors one linked catalogue's products
 * from Meta into `products`.
 *
 * Every page is upserted on (catalogue, retailer_id). A product that Meta no
 * longer returns is marked hidden (never deleted, so old messages and orders
 * can still name it), but only after a complete pass: an error or a page cap
 * mid-way hides nothing. `synced_at` only moves forward (GREATEST), so two
 * overlapping passes cannot hide a product the later one saw.
 *
 * Each run first queues the next six-hour run for the catalogue (one job per
 * slot, deduped), so the chain survives a failed pass; deleting the link ends
 * the chain. Meta failures are stored as a fixed category on the catalogue
 * (sync_error) and the job completes. Tokens and product data are never
 * logged. A complete pass also queues 'commerce.catalog_push' in its final
 * transaction (catalog-push.ts), the periodic reconcile of Bodhinox prices
 * and stock against what it just read from Meta.
 */

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getCatalogProducts, MetaApiError, type MetaCatalogProduct, type MetaCatalogProductsPage } from '@/lib/whatsapp/meta-api';
import { CatalogError, loadCatalogNumber, queueCatalogSync, type CatalogSyncError } from './catalog';
import { queueCatalogPush } from './catalog-push';
import { currencyExponent, isCurrencyCode, MoneyError, parseMoney } from './money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 100 pages of 100: larger catalogues are synced up to the cap and reported, never partially hidden. */
export const CATALOG_SYNC_MAX_PAGES = 100;

export interface NormalisedProduct {
  retailer_id: string;
  meta_product_id: string | null;
  name: string;
  description: string | null;
  price_minor: number | null;
  currency: string | null;
  image_url: string | null;
  url: string | null;
  availability: string | null;
  is_hidden: boolean;
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

function webUrl(value: unknown): string | null {
  const raw = text(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().slice(0, 2048) : null;
  } catch {
    return null;
  }
}

/**
 * A comma is read only as a thousands separator: groups of three ("1,234,567")
 * or the Indian lakh grouping ("1,23,45,678"), optionally followed by a '.'
 * decimal. Anything else with a comma ("12,50", "1,5", "1.234,50") is a comma
 * decimal or unclear. A three-decimal currency (KWD, BHD...) writes "1,234"
 * for 1.234 in comma-decimal locales, so there a comma needs a '.' as well.
 */
const COMMA_THOUSANDS = /^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})+,\d{3})(\.\d+)?$/;

/**
 * Meta's formatted price ("₹1,234.00", "$10.00", "Rs. 99") in minor units, or
 * null when it cannot be read unambiguously (a comma decimal, say). A wrong
 * price is worse than none, so anything unclear is dropped. A '.' followed by
 * more digits than the currency has decimals ("€1.050") is refused by
 * parseMoney.
 */
export function parseMetaPrice(price: unknown, currency: unknown): { price_minor: number | null; currency: string | null } {
  const code = typeof currency === 'string' && isCurrencyCode(currency.trim().toUpperCase()) ? currency.trim().toUpperCase() : null;
  if (!code || typeof price !== 'string') return { price_minor: null, currency: code };
  const cleaned = price.replace(/[^\d.,]/g, '').replace(/^[.,]+/, '').replace(/[.,]+$/, '');
  if (cleaned.includes(',') && (!COMMA_THOUSANDS.test(cleaned)
    || (currencyExponent(code) >= 3 && !cleaned.includes('.')))) return { price_minor: null, currency: code };
  try {
    return { price_minor: cleaned ? parseMoney(cleaned, code) : null, currency: code };
  } catch (error) {
    if (error instanceof MoneyError) return { price_minor: null, currency: code };
    throw error;
  }
}

/** One Meta product as a row, or null when it has no usable retailer id or name. */
export function normaliseMetaProduct(product: MetaCatalogProduct): NormalisedProduct | null {
  const retailerId = text(product.retailer_id, 1000);
  const name = text(product.name, 500);
  if (!retailerId || retailerId.length > 200 || !name) return null;
  const metaId = text(product.id, 64);
  const availability = text(product.availability, 40);
  const visibility = text(product.visibility, 40)?.toLowerCase() ?? null;
  return {
    retailer_id: retailerId,
    meta_product_id: metaId && /^\d+$/.test(metaId) ? metaId : null,
    name,
    description: text(product.description, 10_000),
    ...parseMetaPrice(product.price, product.currency),
    image_url: webUrl(product.image_url),
    url: webUrl(product.url),
    availability: availability ? availability.toLowerCase() : null,
    // Staging (unpublished) products cannot be shown to customers.
    is_hidden: visibility !== null && visibility !== 'published',
  };
}

/** Fixed category for a failed Meta call; nothing from Meta's message is stored. */
export function syncErrorCategory(error: unknown): CatalogSyncError {
  if (error instanceof MetaApiError) {
    if (error.httpStatus === 401 || error.code === 190 || error.code === 10 || error.httpStatus === 403) return 'token';
    if (error.httpStatus === 404 || error.code === 100) return 'not_found';
  }
  return 'unavailable';
}

export type CatalogSyncResult =
  | { status: 'synced'; upserted: number; hidden: number }
  | { status: 'error'; error: CatalogSyncError; upserted: number }
  | { status: 'not_found' };

export type CatalogPageFetcher = (args: { catalogId: string; accessToken: string; after?: string | null; limit?: number }) =>
  Promise<MetaCatalogProductsPage>;

export interface SyncCatalogArgs {
  accountId: string;
  catalogRowId: string;
  /** Test hook; defaults to Meta's catalogue API. */
  fetchPage?: CatalogPageFetcher;
  now?: () => Date;
}

const worker = <T>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

async function recordError(accountId: string, catalogRowId: string, error: CatalogSyncError): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE whatsapp_catalogs SET sync_error=${error}
    WHERE account_id=${accountId}::uuid AND id=${catalogRowId}::uuid`);
}

async function upsertPage(accountId: string, catalogRowId: string, products: NormalisedProduct[], syncedAt: Date): Promise<void> {
  if (!products.length) return;
  await worker(accountId, async (tx) => {
    for (const p of products) {
      await tx.$executeRaw`INSERT INTO products(account_id,catalog_row_id,retailer_id,meta_product_id,name,description,price_minor,
          currency,image_url,url,availability,is_hidden,synced_at)
        VALUES(${accountId}::uuid,${catalogRowId}::uuid,${p.retailer_id},${p.meta_product_id},${p.name},${p.description},
          ${p.price_minor === null ? null : BigInt(p.price_minor)},${p.currency},${p.image_url},${p.url},${p.availability},${p.is_hidden},${syncedAt})
        ON CONFLICT(account_id,catalog_row_id,retailer_id) DO UPDATE SET meta_product_id=EXCLUDED.meta_product_id,name=EXCLUDED.name,
          description=EXCLUDED.description,price_minor=EXCLUDED.price_minor,currency=EXCLUDED.currency,image_url=EXCLUDED.image_url,
          url=EXCLUDED.url,availability=EXCLUDED.availability,is_hidden=EXCLUDED.is_hidden,
          synced_at=GREATEST(products.synced_at,EXCLUDED.synced_at)`;
    }
  });
}

/** One full pass over a catalogue. Meta failures are recorded, not thrown. */
export async function syncCatalog(args: SyncCatalogArgs): Promise<CatalogSyncResult> {
  const { accountId, catalogRowId } = args;
  const fetchPage = args.fetchPage ?? getCatalogProducts;
  const startedAt = (args.now ?? (() => new Date()))();
  const loaded = await worker(accountId, async (tx) => {
    const rows = await tx.$queryRaw<{ catalog_id: string; whatsapp_config_id: string | null }[]>`
      SELECT catalog_id,whatsapp_config_id::text AS whatsapp_config_id FROM whatsapp_catalogs
      WHERE account_id=${accountId}::uuid AND id=${catalogRowId}::uuid`;
    if (!rows[0]) return null;
    // The next six-hour pass is queued first, so a failure below cannot end the chain.
    await queueCatalogSync(tx, accountId, catalogRowId, 'periodic', startedAt.getTime());
    try {
      // A catalogue whose number was removed syncs through the default number.
      return { catalogId: rows[0].catalog_id, number: await loadCatalogNumber(tx, accountId, rows[0].whatsapp_config_id) };
    } catch (error) {
      if (error instanceof CatalogError) return { catalogId: rows[0].catalog_id, number: null };
      throw error;
    }
  });
  if (!loaded) return { status: 'not_found' };
  if (!loaded.number) {
    await recordError(accountId, catalogRowId, 'number_unavailable');
    return { status: 'error', error: 'number_unavailable', upserted: 0 };
  }

  const accessToken = decrypt(loaded.number.accessTokenEnc);
  let after: string | null = null;
  let upserted = 0;
  for (let page = 0; ; page++) {
    if (page >= CATALOG_SYNC_MAX_PAGES) {
      await recordError(accountId, catalogRowId, 'too_many_products');
      return { status: 'error', error: 'too_many_products', upserted };
    }
    let result: MetaCatalogProductsPage;
    try {
      result = await fetchPage({ catalogId: loaded.catalogId, accessToken, after, limit: 100 });
    } catch (error) {
      const category = syncErrorCategory(error);
      await recordError(accountId, catalogRowId, category);
      return { status: 'error', error: category, upserted };
    }
    // Meta can repeat a retailer id across pages; the last one wins.
    const unique = new Map<string, NormalisedProduct>();
    for (const raw of result.products) {
      const product = normaliseMetaProduct(raw);
      if (product) unique.set(product.retailer_id, product);
    }
    await upsertPage(accountId, catalogRowId, [...unique.values()], startedAt);
    upserted += unique.size;
    if (!result.after) break;
    if (result.after === after) {
      // A cursor that does not move would loop; treat the pass as incomplete.
      await recordError(accountId, catalogRowId, 'unavailable');
      return { status: 'error', error: 'unavailable', upserted };
    }
    after = result.after;
  }

  const hidden = await worker(accountId, async (tx) => {
    const count = await tx.$executeRaw`UPDATE products SET is_hidden=true
      WHERE account_id=${accountId}::uuid AND catalog_row_id=${catalogRowId}::uuid AND synced_at<${startedAt} AND NOT is_hidden`;
    await tx.$executeRaw`UPDATE whatsapp_catalogs SET last_synced_at=${startedAt},sync_error=NULL
      WHERE account_id=${accountId}::uuid AND id=${catalogRowId}::uuid`;
    // Bodhinox prices and stock win for linked variants: push what the pass found different (audit finding 20).
    await queueCatalogPush(accountId, tx);
    return count;
  });
  return { status: 'synced', upserted, hidden };
}

/** Job entry point (registered in lib/jobs/handlers.ts). */
export async function handleCatalogSyncJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const catalogRowId = payload.catalogId;
  if (typeof catalogRowId !== 'string' || !UUID.test(catalogRowId)) throw new Error('Invalid catalogue sync contract');
  await syncCatalog({ accountId, catalogRowId });
}
