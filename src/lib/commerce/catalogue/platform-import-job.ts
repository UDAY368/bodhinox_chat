/**
 * Import products from a connected Shopify or WooCommerce store (the pure part is platform-import.ts).
 *
 * An admin queues one import per workspace; the worker pulls the store a page at a time, maps each
 * product to the same rows the CSV import applies (matched by SKU, so a replay updates what it
 * created) and saves a checkpoint after every page: the cursor to resume from and the counters,
 * in one write. A crash between a page and its checkpoint repeats that one page, which finds its
 * SKUs and changes nothing twice. Imported products are drafts.
 *
 * Credentials: Shopify uses the token the install already stored (decrypted by the worker only).
 * WooCommerce has no API keys on file, so the admin types the consumer key and secret for this
 * import; they are encrypted into the job row, unreadable by the app role, and cleared when the job
 * ends. Requests go through safeFetch (public hosts only, no redirects, size and time caps). Nothing
 * here logs a credential, a response body or product content.
 */
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isShopDomain } from '@/lib/integrations/shopify/oauth';
import { SHOPIFY_API_VERSION, parseScopes, scopesSatisfied } from '@/lib/integrations/shopify/config';
import { getShopifyStore, loadShopifyToken } from '@/lib/integrations/shopify/store';
import { listWooStores } from '@/lib/integrations/woocommerce/stores';
import { enqueueJob } from '@/lib/jobs/queue';
import { safeFetch } from '@/lib/webhooks/safe-fetch';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { applyRows, applyStock } from './product-csv-import';
import { MAX_REPORTED_ERRORS, type RowError } from './product-csv';
import {
  MAX_IMPORT_PRODUCTS, mapWooProduct, nextWooPage, parseShopifyPage, parseWooList, PlatformError, retryDecision, shopifyRequestBody,
  toImportRows, WOO_VARIATION_PAGES, WOO_VARIATIONS_PAGE, wooAuthHeader, wooProductsUrl, wooVariationsUrl,
  planPlatformRows, type ImportRowsInput, type Platform, type SourceProduct, type WooRaw,
} from './platform-import';
import { auditCatalogue, CatalogueError } from './products';
import { revalidateShop } from '../shop-cache';

export const PLATFORM_IMPORT_JOB = 'commerce.platform_import';

// ------------------------------------------------------------ views

export interface PlatformImportView {
  id: string;
  platform: Platform;
  source_url: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled';
  cancel_requested: boolean;
  pages_done: number;
  products_seen: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  errors: RowError[];
  error_code: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PlatformStatus {
  shopify: { connected: boolean; shop_domain: string | null; scope_ok: boolean };
  woocommerce: { stores: { id: string; store_url: string; https: boolean }[] };
  imports: PlatformImportView[];
}

export async function listPlatformImports(tx: TenantTransaction, accountId: string): Promise<PlatformImportView[]> {
  const rows = await tx.$queryRaw<(Omit<PlatformImportView, 'created_at' | 'completed_at'> & { created_at: Date; completed_at: Date | null })[]>`
    SELECT id::text AS id, platform, source_url, status, cancel_requested, pages_done, products_seen, created_count, updated_count,
      skipped_count, error_count, errors, error_code, created_at, completed_at
    FROM shop_platform_imports WHERE account_id=${accountId}::uuid ORDER BY created_at DESC, id DESC LIMIT 5`;
  return rows.map((r) => ({ ...r, errors: (r.errors ?? []) as RowError[], created_at: r.created_at.toISOString(), completed_at: r.completed_at?.toISOString() ?? null }));
}

/** What the import dialog needs: which platforms are connected (never a credential) and the latest imports. */
export async function platformStatus(tx: TenantTransaction, accountId: string): Promise<PlatformStatus> {
  const shop = await getShopifyStore(tx, accountId);
  const installed = shop && !shop.uninstalled_at ? shop : null;
  const woo = await listWooStores(tx, accountId);
  return {
    shopify: {
      connected: !!installed,
      shop_domain: installed?.shop_domain ?? null,
      scope_ok: !!installed && scopesSatisfied(['read_products'], parseScopes(installed.scopes)),
    },
    woocommerce: { stores: woo.map((s) => ({ id: s.id, store_url: s.store_url, https: s.store_url.startsWith('https://') })) },
    imports: await listPlatformImports(tx, accountId),
  };
}

// ------------------------------------------------------------ queueing

export type PlatformImportInput =
  | { platform: 'shopify' }
  | { platform: 'woocommerce'; storeId: string; consumerKey: string; consumerSecret: string };

const WOO_KEY = /^[A-Za-z0-9_]{8,120}$/;

/** Check the connection, store the job and queue the worker before answering. One import at a time per workspace (import_running). */
export async function queuePlatformImport(ctx: TenantContext & { userId: string }, input: PlatformImportInput): Promise<{ import_id: string }> {
  const target = await withTenant(ctx, async (tx) => {
    if (input.platform === 'shopify') {
      const store = await getShopifyStore(tx, ctx.accountId);
      if (!store || store.uninstalled_at) throw new CatalogueError('platform_not_connected');
      if (!scopesSatisfied(['read_products'], parseScopes(store.scopes))) throw new CatalogueError('shopify_scope_missing');
      return { url: store.shop_domain, credentials: null as string | null };
    }
    if (!WOO_KEY.test(input.consumerKey)) throw new CatalogueError('invalid', 'consumer_key');
    if (!WOO_KEY.test(input.consumerSecret)) throw new CatalogueError('invalid', 'consumer_secret');
    const store = (await listWooStores(tx, ctx.accountId)).find((s) => s.id === input.storeId);
    if (!store) throw new CatalogueError('platform_not_connected');
    if (!store.store_url.startsWith('https://')) throw new CatalogueError('woo_https_required');
    return { url: store.store_url, credentials: encrypt(JSON.stringify({ key: input.consumerKey, secret: input.consumerSecret })) };
  });
  const id = await withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_platform_imports(account_id, requested_by, platform, source_url, credentials_enc)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, ${input.platform}, ${target.url}, ${target.credentials}) RETURNING id::text AS id`
      .catch((e: { code?: string; meta?: { code?: string }; message?: string }) => {
        if ((e?.meta?.code ?? e?.code) === '23505' || /23505|unique constraint/i.test(e?.message ?? '')) throw new CatalogueError('import_running');
        throw e;
      });
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.products_platform_queued', rows[0].id, { platform: input.platform });
    return rows[0].id;
  });
  try {
    await enqueueJob(PLATFORM_IMPORT_JOB, { importId: id }, { tenantId: ctx.accountId, dedupeKey: `${PLATFORM_IMPORT_JOB}:${id}` });
  } catch (error) {
    await finish(ctx.accountId, id, 'failed', 'queue_failed');
    throw error;
  }
  return { import_id: id };
}

/** Ask the worker to stop after the page it is on. Returns false when the import is not queued or running. */
export async function cancelPlatformImport(ctx: TenantContext & { userId: string }, id: string): Promise<boolean> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE shop_platform_imports SET cancel_requested=true
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid AND status IN ('queued','running') RETURNING id::text AS id`;
    if (rows[0]) await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.products_platform_cancel', id);
    return rows.length > 0;
  });
}

const worker = (accountId: string, userId?: string): TenantContext => ({ accountId, userId, role: 'owner' });

async function finish(accountId: string, id: string, status: 'done' | 'failed' | 'canceled', errorCode: string | null) {
  await withTenant(worker(accountId), (tx) => tx.$executeRaw`
    UPDATE shop_platform_imports SET status=${status}, credentials_enc=NULL, cursor=NULL, error_code=${errorCode}, completed_at=now()
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status IN ('queued','running')`, getWorkerPrisma());
  revalidateShop(accountId);
}

// ------------------------------------------------------------ HTTP

export interface PlatformResponse { status: number; body: string; retryAfter: string | null }
export type PlatformFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<PlatformResponse>;
export interface PlatformDeps { fetch: PlatformFetch; sleep: (ms: number) => Promise<void> }

const BODY_CAP = 8 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 25_000;

/** The production fetcher: public hosts only, no redirects, a size and time cap. A refused host throws; a timeout or network error is status 0. */
export const defaultPlatformFetch: PlatformFetch = async (url, init) => {
  const r = await safeFetch(url, init, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: BODY_CAP });
  if (r.ok) return { status: r.status, body: r.body, retryAfter: r.retryAfter ?? null };
  if (r.error === 'blocked' || r.error === 'invalid_url') throw new PlatformError('blocked');
  if (r.error === 'too_large') throw new PlatformError('bad_response');
  return { status: 0, body: '', retryAfter: null };
};
const defaultDeps: PlatformDeps = { fetch: defaultPlatformFetch, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** One request with the retry rules: rate limits and server trouble wait and try again, a refused login stops. */
async function ask(deps: PlatformDeps, assertLease: () => void, url: string, init: Parameters<PlatformFetch>[1],
  accept: (body: string) => 'ok' | 'throttled' = () => 'ok'): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    assertLease();
    const res = await deps.fetch(url, init);
    let verdict: ReturnType<typeof retryDecision> | null = null;
    if (res.status >= 200 && res.status < 300) {
      if (accept(res.body) === 'ok') return res.body;
      verdict = retryDecision(429, attempt, res.retryAfter);
    } else verdict = retryDecision(res.status, attempt, res.retryAfter);
    if (!verdict.retry) throw new PlatformError(verdict.code);
    await deps.sleep(verdict.delayMs);
  }
}

interface Page { products: SourceProduct[]; next: string | null }

async function shopifyPage(deps: PlatformDeps, assertLease: () => void, shop: string, token: string, cursor: string | null): Promise<Page> {
  if (!isShopDomain(shop)) throw new PlatformError('not_connected');
  let parsed: ReturnType<typeof parseShopifyPage> | null = null;
  await ask(deps, assertLease, `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST', body: shopifyRequestBody(cursor),
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token },
  }, (body) => { parsed = parseShopifyPage(body); return parsed.throttled ? 'throttled' : 'ok'; });
  const page = parsed as ReturnType<typeof parseShopifyPage> | null;
  if (!page) throw new PlatformError('bad_response');
  return { products: page.products, next: page.next };
}

async function wooPage(deps: PlatformDeps, assertLease: () => void, storeUrl: string, auth: string, cursor: string | null): Promise<Page> {
  if (!storeUrl.startsWith('https://')) throw new PlatformError('woo_https_required');
  const headers = { accept: 'application/json', authorization: auth };
  const page = cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 1;
  const list = parseWooList(await ask(deps, assertLease, wooProductsUrl(storeUrl, page), { method: 'GET', headers }));
  const products: SourceProduct[] = [];
  for (const product of list) {
    const raw: WooRaw = { product, variations: [] };
    if (product.type === 'variable' && typeof product.id === 'number') {
      for (let v = 1; v <= WOO_VARIATION_PAGES; v++) {
        const got = parseWooList(await ask(deps, assertLease, wooVariationsUrl(storeUrl, String(product.id), v), { method: 'GET', headers }));
        raw.variations.push(...got);
        if (got.length < WOO_VARIATIONS_PAGE) break;
      }
    }
    const mapped = mapWooProduct(raw);
    if (mapped) products.push(mapped);
  }
  const next = nextWooPage(page, list.length);
  return { products, next: next === null ? null : String(next) };
}

// ------------------------------------------------------------ applying a page

interface PageApplied { created: number; updated: number; skipped: number; errors: RowError[] }

async function applyPage(ctx: { accountId: string; userId: string; role: 'owner' | 'admin' }, platform: Platform, products: SourceProduct[],
  firstRow: number, currency: string | null): Promise<PageApplied> {
  const items: ImportRowsInput[] = [];
  const errors: RowError[] = [];
  let skipped = 0;
  for (const [i, product] of products.entries()) {
    const mapped = toImportRows(product, firstRow + i, currency);
    errors.push(...mapped.errors);
    if (mapped.skipped) skipped++;
    if (mapped.rows.length) items.push({ product, rows: mapped.rows, row: firstRow + i });
  }
  const skus = [...new Set(items.flatMap((i) => i.rows.map((r) => r.sku)))];
  const out = await withTenant(ctx, async (tx) => {
    const found = skus.length ? await tx.$queryRaw<{ sku: string; product_id: string; id: string }[]>`
      SELECT sku, product_id::text AS product_id, id::text AS id FROM shop_variants
      WHERE account_id=${ctx.accountId}::uuid AND sku = ANY(${skus}::text[])` : [];
    const existing = new Map(found.map((f) => [f.sku, { productId: f.product_id, variantId: f.id }]));
    const plan = planPlatformRows(platform, items, existing);
    const applied = await applyRows(tx, ctx.accountId, ctx.userId, plan.planned, new Map(), existing, new Map());
    return { plan, applied };
  }, getPrisma(), { timeoutMs: 120_000 });
  const stockErrors = await applyStock(ctx.accountId, ctx.userId, out.applied.stock);
  return {
    created: out.applied.created, updated: out.applied.updated, skipped,
    errors: [...errors, ...out.plan.errors, ...out.applied.errors, ...stockErrors],
  };
}

// ------------------------------------------------------------ the job

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The commerce.platform_import job (payload { importId }). Resumable: the cursor and the counters move
 * together after each page. A finished, failed or canceled import is a no-op. `deps` is for tests.
 */
export async function handlePlatformImportJob(accountId: string, payload: Record<string, unknown>,
  attempt_: { attempts: number; maxAttempts: number }, assertLease: () => void = () => {}, deps: PlatformDeps = defaultDeps): Promise<void> {
  const id = payload.importId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Invalid platform import job');
  const w = getWorkerPrisma();
  const job = await withTenant(worker(accountId), async (tx) => {
    const rows = await tx.$queryRaw<{ platform: Platform; source_url: string; requested_by: string; credentials_enc: string | null;
      cursor: string | null; products_seen: number }[]>`
      UPDATE shop_platform_imports SET status='running', started_at=COALESCE(started_at, now())
      WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status IN ('queued','running')
      RETURNING platform, source_url, requested_by::text AS requested_by, credentials_enc, cursor, products_seen`;
    return rows[0] ?? null;
  }, w);
  if (!job) return;
  try {
    const role = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ role: string }[]>`
      SELECT role FROM account_memberships WHERE account_id=${accountId}::uuid AND user_id=${job.requested_by}::uuid`, w);
    if (!['owner', 'admin'].includes(role[0]?.role ?? '')) return void (await finish(accountId, id, 'failed', 'not_allowed'));
    const ctx = { accountId, userId: job.requested_by, role: role[0].role as 'owner' | 'admin' };
    const currency = (await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ currency: string }[]>`
      SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid`, w))[0]?.currency ?? null;

    let fetchPage: (cursor: string | null) => Promise<Page>;
    if (job.platform === 'shopify') {
      const token = await loadShopifyToken(accountId);
      if (!token || token.shop !== job.source_url) return void (await finish(accountId, id, 'failed', 'not_connected'));
      fetchPage = (cursor) => shopifyPage(deps, assertLease, token.shop, token.accessToken, cursor);
    } else {
      if (!job.credentials_enc) return void (await finish(accountId, id, 'failed', 'not_connected'));
      const { key, secret } = JSON.parse(decrypt(job.credentials_enc)) as { key: string; secret: string };
      const auth = wooAuthHeader(key, secret);
      fetchPage = (cursor) => wooPage(deps, assertLease, job.source_url, auth, cursor);
    }

    let cursor = job.cursor;
    let seen = job.products_seen;
    for (;;) {
      assertLease();
      const flag = await withTenant(worker(accountId), (tx) => tx.$queryRaw<{ cancel_requested: boolean }[]>`
        SELECT cancel_requested FROM shop_platform_imports WHERE account_id=${accountId}::uuid AND id=${id}::uuid`, w);
      if (flag[0]?.cancel_requested) return void (await finish(accountId, id, 'canceled', null));
      const page = await fetchPage(cursor);
      const room = MAX_IMPORT_PRODUCTS - seen;
      const products = page.products.slice(0, Math.max(room, 0));
      const applied = await applyPage(ctx, job.platform, products, seen + 1, currency);
      const reachedLimit = seen + products.length >= MAX_IMPORT_PRODUCTS && (page.next !== null || products.length < page.products.length);
      await withTenant(worker(accountId), async (tx) => {
        const cur = await tx.$queryRaw<{ errors: RowError[] }[]>`SELECT errors FROM shop_platform_imports
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
        const merged = [...((cur[0]?.errors ?? []) as RowError[]), ...applied.errors].slice(0, MAX_REPORTED_ERRORS);
        await tx.$executeRaw`UPDATE shop_platform_imports SET cursor=${reachedLimit ? null : page.next}, pages_done=pages_done+1,
          products_seen=products_seen+${products.length}, created_count=created_count+${applied.created}, updated_count=updated_count+${applied.updated},
          skipped_count=skipped_count+${applied.skipped}, error_count=error_count+${applied.errors.length}, errors=${JSON.stringify(merged)}::jsonb
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
      }, w);
      seen += products.length;
      cursor = page.next;
      if (reachedLimit || cursor === null) {
        await withTenant(worker(accountId, job.requested_by), async (tx) => {
          const fin = await tx.$queryRaw<{ created_count: number; updated_count: number; skipped_count: number; error_count: number }[]>`
            UPDATE shop_platform_imports SET status='done', credentials_enc=NULL, cursor=NULL, completed_at=now(),
              error_code=${reachedLimit ? 'product_limit' : null}
            WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status='running'
            RETURNING created_count, updated_count, skipped_count, error_count`;
          if (fin[0]) await auditCatalogue(tx, accountId, job.requested_by, 'commerce.products_platform_imported', id,
            { platform: job.platform, created: fin[0].created_count, updated: fin[0].updated_count, skipped: fin[0].skipped_count, errors: fin[0].error_count });
        }, w);
        // In the worker there is no Next data cache to reach: a no-op there, and the shop pages' short TTL bounds staleness.
        revalidateShop(accountId);
        return;
      }
    }
  } catch (error) {
    // A refusal no retry can fix ends the import with its code; anything else is retried until the attempts run out.
    if (error instanceof PlatformError) return void (await finish(accountId, id, 'failed', error.code));
    if (attempt_.attempts >= attempt_.maxAttempts) await finish(accountId, id, 'failed', 'import_failed');
    throw error;
  }
}
