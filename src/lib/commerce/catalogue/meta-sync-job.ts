/**
 * Worker job 'commerce.meta_catalogue_sync' (store plan Phase 4, package 4):
 * creates and updates whole products in the workspace's Meta catalogue, and
 * the admin actions around it (opt-in, "Sync now", reconcile).
 *
 * Off until an admin opts in. The target is the workspace's first linked
 * catalogue. Which products: every published product, or only the ones an
 * admin picked. A variant that was put into Meta and is later unpublished or
 * archived is updated to 'out of stock'; nothing is ever deleted in Meta.
 *
 * One run, in this order:
 *   1 recover  items claimed by a run that died before it stored Meta's answer:
 *              the batch's outbound intent says what happened (below)
 *   2 poll     batches Meta accepted: read each handle and settle its items
 *   3 plan     compare every variant in scope with the digest last pushed
 *   4 send     UPDATE batches, then CREATE batches, each claimed first
 *
 * Durability. Before a batch is sent, one transaction records an outbound
 * intent (outbound_intents, key = workspace + catalogue + method + digest of
 * the items' SKUs, content digests and attempt numbers) and marks its items
 * 'pending' with that key. So whatever happens next, a later run knows the
 * items were in flight and never plans them again by accident:
 *   Meta answered 200       intent 'accepted' (handles kept), items polled
 *   Meta refused (4xx)      intent 'failed'; nothing was applied; items 'failed'
 *                           with a fixed code, or 'not_synced' after throttling
 *   unknown, UPDATE batch   items back to 'not_synced' and the job retries: an
 *                           update is absolute, so sending it twice is harmless
 *   unknown, CREATE batch   intent 'unknown', items 'uncertain'. Never retried.
 *                           An admin reconciles each (reconcileMetaItem reads
 *                           the item by retailer_id): found -> 'synced' (and one
 *                           UPDATE brings its content in line), not found ->
 *                           'not_synced', and only then is it created again.
 * Unknown = a timeout, a network error, a 5xx, a 200 without a handle, a batch
 * status of 'error' / 'canceled' / not found, or a batch still running after an hour.
 *
 * Limits: 500 items a batch, 4 batches a run, 40 batches a workspace per hour,
 * and a pause when Meta throttles (codes 4/17/32/613/80014, HTTP 429) or its
 * X-Business-Use-Case-Usage header reports 90% used.
 *
 * With 'commerce.catalog_push' (price and availability of linked variants):
 * that job leaves out every variant this sync has 'pending' or 'synced', so a
 * change is sent once, by this job, as part of the whole item. Variants this
 * sync does not cover (sync off, product not selected, failed or uncertain
 * here) keep their price and stock push exactly as before.
 *
 * Tokens, product names and prices are never logged or stored in the status rows.
 */

import { ForbiddenError } from '@/lib/auth/account';
import { appOrigin } from '@/lib/auth/csrf';
import { hasMinRole } from '@/lib/auth/roles';
import { getEntitlements } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { assertLiveEffects } from '@/lib/runtime/dry-run-guard';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  checkCatalogBatchStatus, findCatalogItem, MetaApiError, sendCatalogItemsBatch, type MetaBatchStatus, type MetaCatalogItemData,
} from '@/lib/whatsapp/meta-api';
import { CatalogError, loadCatalogNumber } from '../catalog';
import { minorFromDb } from '../money';
import {
  batchIntentKey, buildMetaItem, chunk, classifySendError, interpretBatchStatus, isRateLimit, planItem, rateLimitDelayMs, usageBackoffMs,
  queueMetaSyncIn, META_SYNC_JOB, META_SYNC_BATCH_MAX, META_SYNC_HOURLY_BATCH_CAP, META_SYNC_MAX_BATCHES_PER_RUN, META_SYNC_MAX_POLLS_PER_RUN,
  type ItemOutcome, type ItemState, type LocalRefusal, type MetaSyncMethod, type MetaSyncStatus, type SyncVariant,
} from './meta-sync';
import { asBody, auditCatalogue, CatalogueError, has, isId } from './products';

export { META_SYNC_JOB };
/** A batch still 'dispatching' this long after it was claimed belongs to a run that died. */
const IN_FLIGHT_MS = 3 * 60_000;
/** Reconcile waits this long after the send, so Meta has had time to apply a batch it did take. */
export const RECONCILE_WAIT_MS = 2 * 60_000;
const MAX_SELECTED = 2000;
const PLAN_CAP = 20_000;

export interface MetaSyncDeps {
  send: typeof sendCatalogItemsBatch;
  check: typeof checkCatalogBatchStatus;
  find: typeof findCatalogItem;
  now: () => Date;
}
const defaults: MetaSyncDeps = { send: sendCatalogItemsBatch, check: checkCatalogBatchStatus, find: findCatalogItem, now: () => new Date() };

const worker = <T>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

/** The app's public origin when it is https (Meta refuses other links), else null. */
function publicOrigin(): string | null {
  try {
    const origin = appOrigin();
    return origin.startsWith('https://') ? origin : null;
  } catch {
    return null;
  }
}

interface Target { rowId: string; catalogId: string; accessTokenEnc: string }

/** The workspace's first linked catalogue and a usable number for it, or null (not connected). */
async function loadTarget(tx: TenantTransaction, accountId: string): Promise<Target | null> {
  const rows = await tx.$queryRaw<{ id: string; catalog_id: string; whatsapp_config_id: string | null }[]>`
    SELECT id::text AS id, catalog_id, whatsapp_config_id::text AS whatsapp_config_id FROM whatsapp_catalogs
    WHERE account_id=${accountId}::uuid ORDER BY created_at, id LIMIT 1`;
  if (!rows[0]) return null;
  try {
    const number = await loadCatalogNumber(tx, accountId, rows[0].whatsapp_config_id);
    return { rowId: rows[0].id, catalogId: rows[0].catalog_id, accessTokenEnc: number.accessTokenEnc };
  } catch (error) {
    if (error instanceof CatalogError) return null;
    throw error;
  }
}

/**
 * Queues a run (one per workspace per minute) when the workspace has opted in;
 * otherwise nothing. Pass `tx` to queue inside a change's transaction.
 */
export async function queueMetaCatalogueSync(accountId: string, options: { tx?: TenantTransaction; delayMs?: number; now?: Date } = {}): Promise<void> {
  if (options.tx) await queueMetaSyncIn(options.tx, accountId, options);
  else await worker(accountId, (tx) => queueMetaSyncIn(tx, accountId, options));
}

type Settle = Exclude<ItemOutcome, 'wait'>;

/** Moves pending items to their outcome. Only rows still 'pending' change, so a row settled elsewhere is left alone. */
async function settle(tx: TenantTransaction, accountId: string, ids: string[], outcome: Settle, now: Date,
  error: { code: string; detail?: string | null } | null = null): Promise<number> {
  if (!ids.length) return 0;
  const status: MetaSyncStatus = outcome === 'retry' ? 'not_synced' : outcome;
  const code = outcome === 'uncertain' ? 'outcome_unknown' : outcome === 'failed' ? (error?.code ?? 'meta_item_invalid') : null;
  const detail = outcome === 'failed' ? (error?.detail ?? null) : null;
  return tx.$executeRaw`UPDATE shop_meta_sync_items SET status=${status},
      in_meta=in_meta OR ${outcome === 'synced'},
      synced_at=CASE WHEN ${outcome === 'synced'} THEN ${now}::timestamptz ELSE synced_at END,
      pushed_hash=CASE WHEN ${outcome === 'retry'} THEN NULL ELSE pushed_hash END,
      intent_key=CASE WHEN ${outcome === 'retry'} THEN NULL ELSE intent_key END,
      batch_handle=NULL, error_code=${code}::text, error_detail=${detail}::text, last_checked_at=${now}, updated_at=${now}
    WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[]) AND status='pending'`;
}

export interface MetaSyncRunResult {
  status: 'off' | 'not_connected' | 'ran';
  /** Batches sent to Meta in this run. */
  batches: number;
  /** Items in those batches. */
  sent: number;
  synced: number;
  failed: number;
  uncertain: number;
  /** A later run was queued (backlog, a batch still running, or a pause). */
  requeued: boolean;
}

interface Candidate extends SyncVariant { mirrored: boolean; row: (ItemState & { attempts: number }) | null }

async function loadCandidates(tx: TenantTransaction, accountId: string, target: Target, scope: string, productIds: string[]): Promise<Candidate[]> {
  const rows = await tx.$queryRaw<{
    variant_id: string; product_id: string; slug: string | null; sku: string; name: string; description: string | null; brand: string | null;
    option_values: unknown; price: bigint | null; currency: string | null; sellable: boolean; image_id: string | null; image_url: string | null;
    mirrored: boolean; status: MetaSyncStatus | null; catalog_id: string | null; retailer_id: string | null; pushed_hash: string | null;
    in_meta: boolean | null; error_code: string | null; attempts: number | null;
  }[]>`
    SELECT v.id::text AS variant_id, p.id::text AS product_id, p.slug, v.sku, p.name, p.description, p.brand, v.option_values,
      v.price_minor AS price, st.currency,
      (p.status='published' AND v.archived_at IS NULL AND (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0)) AS sellable,
      img.id::text AS image_id, img.url AS image_url,
      -- In Meta as of the last complete catalogue sync (a hidden row that pass still saw is a staging item: it exists).
      EXISTS (SELECT 1 FROM products m JOIN whatsapp_catalogs c ON c.account_id=m.account_id AND c.id=m.catalog_row_id
        WHERE m.account_id=v.account_id AND m.catalog_row_id=${target.rowId}::uuid AND m.retailer_id=v.sku
          AND (NOT m.is_hidden OR m.synced_at >= c.last_synced_at)) AS mirrored,
      i.status, i.catalog_id, i.retailer_id, i.pushed_hash, i.in_meta, i.error_code, i.attempts
    FROM shop_variants v
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    LEFT JOIN commerce_settings st ON st.account_id=v.account_id
    LEFT JOIN shop_meta_sync_items i ON i.account_id=v.account_id AND i.variant_id=v.id
    LEFT JOIN LATERAL (SELECT pi.id, pi.url FROM shop_product_images pi
      WHERE pi.account_id=v.account_id AND pi.product_id=v.product_id AND (pi.url IS NOT NULL OR pi.media_id IS NOT NULL)
      ORDER BY (pi.id = v.image_id) DESC NULLS LAST, pi.position LIMIT 1) img ON true
    WHERE v.account_id=${accountId}::uuid AND (${scope}::text='all' OR p.id=ANY(${productIds}::uuid[]))
      AND ((p.status='published' AND v.archived_at IS NULL) OR (i.in_meta AND i.catalog_id=${target.catalogId}))
    ORDER BY v.id LIMIT ${PLAN_CAP}`;
  return rows.map((r) => ({
    variant_id: r.variant_id, product_id: r.product_id, slug: r.slug, sku: r.sku, name: r.name, description: r.description, brand: r.brand,
    option_values: (r.option_values && typeof r.option_values === 'object' ? r.option_values : {}) as Record<string, string>,
    price_minor: minorFromDb(r.price), currency: r.currency, sellable: r.sellable,
    image: r.image_id ? { id: r.image_id, url: r.image_url } : null,
    mirrored: r.mirrored,
    row: r.status ? { status: r.status, catalog_id: r.catalog_id!, retailer_id: r.retailer_id!, pushed_hash: r.pushed_hash,
      in_meta: !!r.in_meta, error_code: r.error_code, attempts: r.attempts ?? 0 } : null,
  }));
}

interface Planned { variantId: string; retailerId: string; hash: string; attempts: number; data: MetaCatalogItemData }

class ClaimLost extends Error {}

/**
 * Step 1. Items marked pending without a handle were claimed by a run that did not get to store
 * Meta's answer. Their intent decides: accepted -> poll its handle; failed -> nothing was applied;
 * still dispatching and recent -> another run is sending it now; otherwise unknown.
 */
async function recover(accountId: string, now: Date, counts: MetaSyncRunResult): Promise<void> {
  await worker(accountId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; method: MetaSyncMethod | null; intent_key: string; intent_status: string | null;
      result: { handles?: unknown } | null; intent_updated_at: Date | null }[]>`
      SELECT i.id::text AS id, i.method, i.intent_key, o.status AS intent_status, o.result, o.updated_at AS intent_updated_at
      FROM shop_meta_sync_items i
      LEFT JOIN outbound_intents o ON o.account_id=i.account_id AND o.idempotency_key=i.intent_key
      WHERE i.account_id=${accountId}::uuid AND i.status='pending' AND i.batch_handle IS NULL`;
    const unknownIds = (list: typeof rows, method: MetaSyncMethod) => list.filter((r) => (r.method ?? 'CREATE') === method).map((r) => r.id);
    const byKey = new Map<string, typeof rows>();
    for (const row of rows) byKey.set(row.intent_key, [...(byKey.get(row.intent_key) ?? []), row]);
    for (const [key, list] of byKey) {
      const intent = list[0];
      const handle = Array.isArray(intent.result?.handles) && typeof intent.result.handles[0] === 'string' ? intent.result.handles[0] as string : null;
      if (intent.intent_status === 'accepted' && handle) {
        await tx.$executeRaw`UPDATE shop_meta_sync_items SET batch_handle=${handle}, updated_at=${now}
          WHERE account_id=${accountId}::uuid AND intent_key=${key} AND status='pending' AND batch_handle IS NULL`;
        continue;
      }
      if (intent.intent_status === 'failed') { await settle(tx, accountId, list.map((r) => r.id), 'retry', now); continue; }
      if (intent.intent_status === 'dispatching' && intent.intent_updated_at && now.getTime() - intent.intent_updated_at.getTime() < IN_FLIGHT_MS) continue;
      if (intent.intent_status === 'dispatching') {
        await tx.$executeRaw`UPDATE outbound_intents SET status='unknown', last_error='Provider outcome uncertain', updated_at=NOW()
          WHERE account_id=${accountId}::uuid AND idempotency_key=${key} AND status='dispatching'`;
      }
      await settle(tx, accountId, unknownIds(list, 'UPDATE'), 'retry', now);
      counts.uncertain += await settle(tx, accountId, unknownIds(list, 'CREATE'), 'uncertain', now);
    }
  });
}

/** Step 2. Returns the delay before the next run when a batch is still running or Meta throttled the read, else null. */
async function poll(accountId: string, accessToken: string, deps: MetaSyncDeps, counts: MetaSyncRunResult): Promise<number | null> {
  const now = deps.now();
  const rows = await worker(accountId, (tx) => tx.$queryRaw<{ id: string; retailer_id: string; method: MetaSyncMethod | null; catalog_id: string;
    batch_handle: string; last_pushed_at: Date | null }[]>`
    SELECT id::text AS id, retailer_id, method, catalog_id, batch_handle, last_pushed_at FROM shop_meta_sync_items
    WHERE account_id=${accountId}::uuid AND status='pending' AND batch_handle IS NOT NULL ORDER BY last_pushed_at, id LIMIT 20000`);
  const byHandle = new Map<string, typeof rows>();
  for (const row of rows) byHandle.set(row.batch_handle, [...(byHandle.get(row.batch_handle) ?? []), row]);
  let again: number | null = byHandle.size > META_SYNC_MAX_POLLS_PER_RUN ? 0 : null;
  for (const [handle, list] of [...byHandle].slice(0, META_SYNC_MAX_POLLS_PER_RUN)) {
    const ageMs = now.getTime() - (list[0].last_pushed_at?.getTime() ?? 0);
    let status: MetaBatchStatus;
    try {
      status = await deps.check({ catalogId: list[0].catalog_id, accessToken, handle });
    } catch (error) {
      if (error instanceof MetaApiError) console.warn('[meta-sync] batch status refused', error.httpStatus, error.code);
      if (isRateLimit(error)) return rateLimitDelayMs(1);
      // A read that failed says nothing about the batch. Ask again later; give up asking after an hour (unknown outcome).
      status = { status: 'started', invalidIds: [], errorsTruncated: false };
    }
    const groups = new Map<ItemOutcome, string[]>();
    for (const row of list) {
      const outcome = interpretBatchStatus(status, { retailerId: row.retailer_id, method: row.method ?? 'CREATE' }, ageMs);
      groups.set(outcome, [...(groups.get(outcome) ?? []), row.id]);
    }
    await worker(accountId, async (tx) => {
      for (const [outcome, ids] of groups) {
        if (outcome === 'wait') {
          await tx.$executeRaw`UPDATE shop_meta_sync_items SET last_checked_at=${now} WHERE account_id=${accountId}::uuid AND id=ANY(${ids}::uuid[])`;
          continue;
        }
        const changed = await settle(tx, accountId, ids, outcome, now);
        if (outcome === 'synced') counts.synced += changed;
        if (outcome === 'failed') counts.failed += changed;
        if (outcome === 'uncertain') counts.uncertain += changed;
      }
    });
    if (groups.has('wait')) again = Math.max(again ?? 0, 60_000);
  }
  return again;
}

/** Records local refusals (no price, picture or public link) as failed rows, without calling Meta. */
async function recordRefusals(accountId: string, catalogId: string, refused: { variantId: string; retailerId: string; code: LocalRefusal; hash: string }[], now: Date) {
  if (!refused.length) return;
  await worker(accountId, (tx) => tx.$executeRaw`
    INSERT INTO shop_meta_sync_items(account_id,variant_id,catalog_id,retailer_id,status,error_code,pushed_hash)
    SELECT ${accountId}::uuid, x.variant_id, ${catalogId}, x.retailer_id, 'failed', x.code, x.hash
    FROM jsonb_to_recordset(${JSON.stringify(refused.map((r) => ({ variant_id: r.variantId, retailer_id: r.retailerId, code: r.code, hash: r.hash })))}::jsonb)
      AS x(variant_id uuid, retailer_id text, code text, hash text)
    ON CONFLICT(account_id,variant_id) DO UPDATE SET status='failed', error_code=EXCLUDED.error_code, error_detail=NULL, pushed_hash=EXCLUDED.pushed_hash,
      in_meta=shop_meta_sync_items.in_meta AND shop_meta_sync_items.catalog_id=EXCLUDED.catalog_id AND shop_meta_sync_items.retailer_id=EXCLUDED.retailer_id,
      catalog_id=EXCLUDED.catalog_id, retailer_id=EXCLUDED.retailer_id, batch_handle=NULL, updated_at=${now}
    WHERE shop_meta_sync_items.status NOT IN ('pending','uncertain')`);
}

/**
 * The intent and the items' pending marks commit together, before the call. A batch another run
 * already claimed (same key), or an item that moved meanwhile, rolls the claim back: nothing is sent.
 */
async function claim(accountId: string, catalogId: string, method: MetaSyncMethod, key: string, items: Planned[], now: Date): Promise<boolean> {
  try {
    await worker(accountId, async (tx) => {
      const intent = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES(${accountId}::uuid,${key},'dispatching')
        ON CONFLICT(idempotency_key) DO NOTHING RETURNING id::text AS id`;
      if (!intent.length) throw new ClaimLost();
      const marked = await tx.$executeRaw`
        INSERT INTO shop_meta_sync_items(account_id,variant_id,catalog_id,retailer_id,status,method,in_meta,pushed_hash,intent_key,attempts,last_pushed_at)
        SELECT ${accountId}::uuid, x.variant_id, ${catalogId}, x.retailer_id, 'pending', ${method}, ${method === 'UPDATE'}, x.hash, ${key}, x.attempts + 1, ${now}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(items.map((i) => ({ variant_id: i.variantId, retailer_id: i.retailerId, hash: i.hash, attempts: i.attempts })))}::jsonb)
          AS x(variant_id uuid, retailer_id text, hash text, attempts int)
        ON CONFLICT(account_id,variant_id) DO UPDATE SET catalog_id=EXCLUDED.catalog_id, retailer_id=EXCLUDED.retailer_id, status='pending',
          method=EXCLUDED.method, in_meta=EXCLUDED.in_meta, pushed_hash=EXCLUDED.pushed_hash, intent_key=EXCLUDED.intent_key, batch_handle=NULL,
          error_code=NULL, error_detail=NULL, attempts=EXCLUDED.attempts, last_pushed_at=EXCLUDED.last_pushed_at, updated_at=EXCLUDED.last_pushed_at
        WHERE shop_meta_sync_items.status NOT IN ('pending','uncertain') AND shop_meta_sync_items.attempts=EXCLUDED.attempts - 1`;
      if (marked !== items.length) throw new ClaimLost();
    });
    return true;
  } catch (error) {
    if (error instanceof ClaimLost) return false;
    throw error;
  }
}

const closeIntent = (tx: TenantTransaction, accountId: string, key: string, status: 'accepted' | 'failed' | 'unknown', note: string | null, result: object | null = null) =>
  tx.$executeRaw`UPDATE outbound_intents SET status=${status}, last_error=${note}::text, result=${result ? JSON.stringify(result) : null}::jsonb, updated_at=NOW()
    WHERE account_id=${accountId}::uuid AND idempotency_key=${key} AND status='dispatching'`;

/** One run of the job. Throws only when an UPDATE batch had an unknown outcome (the job retries it). */
export async function runMetaCatalogueSync(accountId: string, options: { force?: boolean } = {}, overrides: Partial<MetaSyncDeps> = {}): Promise<MetaSyncRunResult> {
  const deps = { ...defaults, ...overrides };
  const counts: MetaSyncRunResult = { status: 'ran', batches: 0, sent: 0, synced: 0, failed: 0, uncertain: 0, requeued: false };
  const loaded = await worker(accountId, async (tx) => {
    const [settings] = await tx.$queryRaw<{ enabled: boolean; scope: string; product_ids: string[] }[]>`
      SELECT enabled, scope, product_ids::text[] AS product_ids FROM shop_meta_sync_settings WHERE account_id=${accountId}::uuid`;
    if (!settings?.enabled || !(await getEntitlements(tx, accountId)).features.storefront) return 'off' as const;
    const target = await loadTarget(tx, accountId);
    if (!target) return 'not_connected' as const;
    const [shop] = await tx.$queryRaw<{ handle: string; published: boolean }[]>`
      SELECT handle, published FROM shop_storefronts WHERE account_id=${accountId}::uuid`;
    return { settings, target, handle: shop?.published ? shop.handle : null };
  });
  if (loaded === 'off' || loaded === 'not_connected') return { ...counts, status: loaded };
  const { settings, target } = loaded;
  const accessToken = decrypt(target.accessTokenEnc);

  await recover(accountId, deps.now(), counts);
  let delay = await poll(accountId, accessToken, deps, counts);

  // Step 3: plan.
  const candidates = await worker(accountId, (tx) => loadCandidates(tx, accountId, target, settings.scope, settings.product_ids));
  const context = { catalogId: target.catalogId, origin: publicOrigin(), handle: loaded.handle };
  const refused: { variantId: string; retailerId: string; code: LocalRefusal; hash: string }[] = [];
  const plan: Record<MetaSyncMethod, Planned[]> = { UPDATE: [], CREATE: [] };
  for (const c of candidates) {
    const build = buildMetaItem(c, context);
    const action = planItem(c.row, build, { catalogId: target.catalogId, sku: c.sku, mirrored: c.mirrored, force: options.force === true });
    if (action.kind === 'refuse') refused.push({ variantId: c.variant_id, retailerId: c.sku, code: action.code, hash: build.hash });
    else if (action.kind === 'send' && build.ok)
      plan[action.method].push({ variantId: c.variant_id, retailerId: c.sku, hash: build.hash, attempts: c.row?.attempts ?? 0, data: build.data });
  }
  await recordRefusals(accountId, target.catalogId, refused, deps.now());
  counts.failed += refused.length;

  // Step 4: send. Updates first: they are the safe ones.
  const batches = [...chunk(plan.UPDATE, META_SYNC_BATCH_MAX).map((items) => ({ method: 'UPDATE' as const, items })),
    ...chunk(plan.CREATE, META_SYNC_BATCH_MAX).map((items) => ({ method: 'CREATE' as const, items }))];
  let retryUpdate = false;
  if (batches.length) {
    assertLiveEffects('dispatch');
    const [{ used }] = await worker(accountId, (tx) => tx.$queryRaw<{ used: number }[]>`
      SELECT count(*)::int AS used FROM outbound_intents
      WHERE account_id=${accountId}::uuid AND idempotency_key LIKE ${`${accountId}:meta-catalogue:%`} AND created_at > NOW() - INTERVAL '1 hour'`);
    let budget = Math.min(META_SYNC_MAX_BATCHES_PER_RUN, META_SYNC_HOURLY_BATCH_CAP - used);
    if (budget <= 0) delay = Math.max(delay ?? 0, 10 * 60_000);
    else if (batches.length > budget) delay = Math.max(delay ?? 0, 0);
    for (const batch of batches) {
      if (budget <= 0) break;
      budget -= 1;
      const now = deps.now();
      const key = batchIntentKey(accountId, target.catalogId, batch.method, batch.items);
      if (!(await claim(accountId, target.catalogId, batch.method, key, batch.items, now))) continue;
      const ids = async (tx: TenantTransaction) => (await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM shop_meta_sync_items WHERE account_id=${accountId}::uuid AND intent_key=${key} AND status='pending'`).map((r) => r.id);
      let response: Awaited<ReturnType<MetaSyncDeps['send']>>;
      try {
        response = await deps.send({ catalogId: target.catalogId, accessToken, method: batch.method, items: batch.items.map((i) => i.data) });
      } catch (error) {
        if (error instanceof MetaApiError) console.warn('[meta-sync] batch refused', error.httpStatus, error.code, error.subcode);
        const failure = classifySendError(error, batch.method);
        await worker(accountId, async (tx) => {
          const pending = await ids(tx);
          if (failure.kind === 'rate_limited') {
            await closeIntent(tx, accountId, key, 'failed', 'Provider rejected the request');
            await settle(tx, accountId, pending, 'retry', now);
          } else if (failure.kind === 'rejected') {
            await closeIntent(tx, accountId, key, 'failed', 'Provider rejected the request');
            counts.failed += await settle(tx, accountId, pending, 'failed', now, { code: failure.code, detail: failure.detail });
          } else if (failure.kind === 'retryable') {
            // Not 'unknown': an update needs no reconciliation, it is sent again.
            await closeIntent(tx, accountId, key, 'failed', 'Update outcome unknown; sent again');
            await settle(tx, accountId, pending, 'retry', now);
          } else {
            await closeIntent(tx, accountId, key, 'unknown', 'Provider outcome uncertain');
            counts.uncertain += await settle(tx, accountId, pending, 'uncertain', now);
          }
        });
        if (failure.kind === 'rate_limited') delay = Math.max(delay ?? 0, failure.delayMs);
        if (failure.kind === 'retryable') retryUpdate = true;
        // Meta is throttling, unwell or refusing this token: stop for this run. A plain refusal of one batch does not stop the next.
        if (failure.kind !== 'rejected' || failure.stop) break;
        continue;
      }
      counts.batches += 1;
      counts.sent += batch.items.length;
      const handle = response.handles[0] ?? null;
      await worker(accountId, async (tx) => {
        await closeIntent(tx, accountId, key, 'accepted', null, { handles: response.handles });
        if (handle) {
          await tx.$executeRaw`UPDATE shop_meta_sync_items SET batch_handle=${handle}, updated_at=${now}
            WHERE account_id=${accountId}::uuid AND intent_key=${key} AND status='pending'`;
        } else if (batch.method === 'CREATE') {
          // Accepted, but nothing to poll: the outcome cannot be known.
          counts.uncertain += await settle(tx, accountId, await ids(tx), 'uncertain', now);
        } else {
          counts.failed += await settle(tx, accountId, await ids(tx), 'failed', now, { code: 'no_handle' });
        }
      });
      if (handle) delay = Math.max(delay ?? 0, 0);
      const pause = usageBackoffMs(response.usage);
      if (pause !== null) { delay = Math.max(delay ?? 0, pause); break; }
    }
  }
  if (delay !== null) {
    await queueMetaCatalogueSync(accountId, { delayMs: delay, now: deps.now() });
    counts.requeued = true;
  }
  if (retryUpdate) throw new Error('Meta catalogue update outcome unknown; retrying');
  return counts;
}

/** Job entry point (registered in lib/jobs/handlers.ts). */
export async function handleMetaCatalogueSyncJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  await runMetaCatalogueSync(accountId, { force: payload.force === true });
}

// ------------------------------------------------------------ admin side

function assertAdmin(ctx: TenantContext): void {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
}

export interface MetaSyncProblem {
  variant_id: string;
  product_id: string;
  product_name: string;
  sku: string;
  status: 'failed' | 'uncertain';
  error_code: string | null;
  error_detail: string | null;
  last_pushed_at: string | null;
}

export interface MetaSyncView {
  /** A Meta catalogue is linked to this workspace. */
  connected: boolean;
  enabled: boolean;
  scope: 'all' | 'selected';
  counts: Record<MetaSyncStatus, number>;
  /** Failed and uncertain items, newest first (at most 200). */
  problems: MetaSyncProblem[];
  /** Published products with the worst status among their variants (at most 500). */
  products: { product_id: string; name: string; variants: number; status: MetaSyncStatus; selected: boolean }[];
}

/** What the Meta panel shows (members; read-only). */
export async function getMetaSyncView(tx: TenantTransaction, accountId: string): Promise<MetaSyncView> {
  const [settings] = await tx.$queryRaw<{ enabled: boolean; scope: 'all' | 'selected'; product_ids: string[] }[]>`
    SELECT enabled, scope, product_ids::text[] AS product_ids FROM shop_meta_sync_settings WHERE account_id=${accountId}::uuid`;
  const [catalog] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM whatsapp_catalogs WHERE account_id=${accountId}::uuid LIMIT 1`;
  const tally = await tx.$queryRaw<{ status: MetaSyncStatus; n: number }[]>`
    SELECT status, count(*)::int AS n FROM shop_meta_sync_items WHERE account_id=${accountId}::uuid GROUP BY status`;
  const problems = await tx.$queryRaw<(Omit<MetaSyncProblem, 'last_pushed_at'> & { last_pushed_at: Date | null })[]>`
    SELECT i.variant_id::text AS variant_id, p.id::text AS product_id, p.name AS product_name, v.sku, i.status, i.error_code, i.error_detail, i.last_pushed_at
    FROM shop_meta_sync_items i
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE i.account_id=${accountId}::uuid AND i.status IN ('failed','uncertain')
    ORDER BY (i.status='uncertain') DESC, i.updated_at DESC LIMIT 200`;
  const products = await tx.$queryRaw<{ product_id: string; name: string; variants: number; uncertain: boolean; failed: boolean; pending: boolean; unsynced: boolean }[]>`
    SELECT p.id::text AS product_id, p.name, count(v.id)::int AS variants,
      COALESCE(bool_or(i.status='uncertain'), false) AS uncertain, COALESCE(bool_or(i.status='failed'), false) AS failed,
      COALESCE(bool_or(i.status='pending'), false) AS pending, COALESCE(bool_or(i.status IS NULL OR i.status='not_synced'), true) AS unsynced
    FROM shop_products p
    JOIN shop_variants v ON v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL
    LEFT JOIN shop_meta_sync_items i ON i.account_id=v.account_id AND i.variant_id=v.id
    WHERE p.account_id=${accountId}::uuid AND p.status='published'
    GROUP BY p.id, p.name ORDER BY lower(p.name), p.id LIMIT 500`;
  const counts: Record<MetaSyncStatus, number> = { not_synced: 0, pending: 0, synced: 0, failed: 0, uncertain: 0 };
  for (const row of tally) counts[row.status] = row.n;
  const selected = new Set(settings?.product_ids ?? []);
  return {
    connected: !!catalog,
    enabled: !!settings?.enabled,
    scope: settings?.scope ?? 'all',
    counts,
    problems: problems.map((p) => ({ ...p, last_pushed_at: p.last_pushed_at ? p.last_pushed_at.toISOString() : null })),
    products: products.map((p) => ({
      product_id: p.product_id, name: p.name, variants: p.variants, selected: selected.has(p.product_id),
      status: p.uncertain ? 'uncertain' : p.failed ? 'failed' : p.pending ? 'pending' : p.unsynced ? 'not_synced' : 'synced',
    })),
  };
}

export interface MetaSyncSettingsInput {
  enabled?: boolean;
  scope?: 'all' | 'selected';
  /** Add one product to, or remove one from, the 'selected' list. */
  select?: string;
  deselect?: string;
}

/** Validates a PUT body; throws CatalogueError('invalid'). */
export function parseMetaSyncSettings(raw: unknown): MetaSyncSettingsInput {
  const b = asBody(raw);
  const input: MetaSyncSettingsInput = {};
  if (has(b, 'enabled')) {
    if (typeof b.enabled !== 'boolean') throw new CatalogueError('invalid', 'enabled');
    input.enabled = b.enabled;
  }
  if (has(b, 'scope')) {
    if (b.scope !== 'all' && b.scope !== 'selected') throw new CatalogueError('invalid', 'scope');
    input.scope = b.scope;
  }
  for (const key of ['select', 'deselect'] as const) {
    if (!has(b, key)) continue;
    if (!isId(b[key])) throw new CatalogueError('invalid', key);
    input[key] = b[key];
  }
  if (input.select && input.deselect) throw new CatalogueError('invalid', 'select');
  return input;
}

/** Admins: turn the sync on or off and choose what it covers. Turning it on needs a linked catalogue; a run is queued in the same transaction. */
export async function saveMetaSyncSettings(ctx: TenantContext & { userId: string }, input: MetaSyncSettingsInput): Promise<MetaSyncView> {
  assertAdmin(ctx);
  return withTenant(ctx, async (tx) => {
    const accountId = ctx.accountId;
    if (input.enabled) {
      const [catalog] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM whatsapp_catalogs WHERE account_id=${accountId}::uuid LIMIT 1`;
      if (!catalog) throw new CatalogueError('meta_not_connected');
    }
    if (input.select) {
      const [product] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_products WHERE account_id=${accountId}::uuid AND id=${input.select}::uuid`;
      if (!product) throw new CatalogueError('not_found');
      const [current] = await tx.$queryRaw<{ n: number }[]>`
        SELECT cardinality(product_ids) AS n FROM shop_meta_sync_settings WHERE account_id=${accountId}::uuid`;
      if ((current?.n ?? 0) >= MAX_SELECTED) throw new CatalogueError('invalid', 'select');
    }
    const select = input.select ?? null;
    const deselect = input.deselect ?? null;
    await tx.$executeRaw`
      INSERT INTO shop_meta_sync_settings AS s (account_id, enabled, scope, product_ids, updated_by)
      VALUES(${accountId}::uuid, ${input.enabled ?? false}, ${input.scope ?? 'all'}, ARRAY_REMOVE(ARRAY[${select}::uuid], NULL), ${ctx.userId}::uuid)
      ON CONFLICT(account_id) DO UPDATE SET
        enabled=COALESCE(${input.enabled ?? null}::boolean, s.enabled),
        scope=COALESCE(${input.scope ?? null}::text, s.scope),
        product_ids=CASE
          WHEN ${select}::uuid IS NOT NULL AND NOT (${select}::uuid = ANY(s.product_ids)) THEN array_append(s.product_ids, ${select}::uuid)
          WHEN ${deselect}::uuid IS NOT NULL THEN array_remove(s.product_ids, ${deselect}::uuid)
          ELSE s.product_ids END,
        updated_by=${ctx.userId}::uuid, updated_at=now()`;
    await auditCatalogue(tx, accountId, ctx.userId, 'commerce.meta_sync_settings', accountId,
      { enabled: input.enabled ?? null, scope: input.scope ?? null, selected: !!select, deselected: !!deselect });
    await queueMetaCatalogueSync(accountId, { tx });
    return getMetaSyncView(tx, accountId);
  });
}

/** Admins: "Sync now". Queued before it is acknowledged (once a minute per workspace); also sends failed items again. */
export async function requestMetaSync(ctx: TenantContext & { userId: string }, now: Date = new Date()): Promise<void> {
  assertAdmin(ctx);
  await withTenant(ctx, async (tx) => {
    const view = await getMetaSyncView(tx, ctx.accountId);
    if (!view.connected) throw new CatalogueError('meta_not_connected');
    if (!view.enabled) throw new CatalogueError('meta_sync_off');
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.meta_sync_requested', ctx.accountId);
  });
  await enqueueJob(META_SYNC_JOB, { force: true },
    { tenantId: ctx.accountId, dedupeKey: `meta-catalogue-sync:${ctx.accountId}:now:${Math.floor(now.getTime() / 60_000)}`, maxAttempts: 3 });
}

/**
 * Admins: resolve an uncertain item by reading it from Meta by retailer_id.
 * Found: 'synced' (its digest is cleared, so the next run sends one UPDATE that
 * brings the content in line). Not found: 'not_synced', and the next run creates
 * it. A failed read leaves it uncertain. Only an uncertain row can be resolved.
 */
export async function reconcileMetaItem(ctx: TenantContext & { userId: string }, variantId: string,
  overrides: Partial<Pick<MetaSyncDeps, 'find' | 'now'>> = {}): Promise<{ status: 'synced' | 'not_synced' }> {
  assertAdmin(ctx);
  const deps = { ...defaults, ...overrides };
  const now = deps.now();
  const loaded = await withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ catalog_id: string; retailer_id: string; status: string; last_pushed_at: Date | null }[]>`
      SELECT catalog_id, retailer_id, status, last_pushed_at FROM shop_meta_sync_items
      WHERE account_id=${ctx.accountId}::uuid AND variant_id=${variantId}::uuid`;
    if (!row) throw new CatalogueError('not_found');
    if (row.status !== 'uncertain') throw new CatalogueError('conflict');
    if (row.last_pushed_at && now.getTime() - row.last_pushed_at.getTime() < RECONCILE_WAIT_MS) throw new CatalogueError('reconcile_too_soon');
    const [catalog] = await tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
      SELECT whatsapp_config_id::text AS whatsapp_config_id FROM whatsapp_catalogs
      WHERE account_id=${ctx.accountId}::uuid AND catalog_id=${row.catalog_id}`;
    if (!catalog) throw new CatalogueError('meta_not_connected');
    try {
      const number = await loadCatalogNumber(tx, ctx.accountId, catalog.whatsapp_config_id);
      return { row, accessTokenEnc: number.accessTokenEnc };
    } catch (error) {
      if (error instanceof CatalogError) throw new CatalogueError('meta_not_connected');
      throw error;
    }
  });
  let found: { id: string } | null;
  try {
    found = await deps.find({ catalogId: loaded.row.catalog_id, accessToken: decrypt(loaded.accessTokenEnc), retailerId: loaded.row.retailer_id });
  } catch (error) {
    if (error instanceof MetaApiError) console.warn('[meta-sync] reconcile read refused', error.httpStatus, error.code);
    throw new CatalogueError('meta_unavailable');
  }
  const status = found ? 'synced' as const : 'not_synced' as const;
  const metaId = found && /^\d{1,32}$/.test(found.id) ? found.id : null;
  await withTenant(ctx, async (tx) => {
    const changed = await tx.$executeRaw`UPDATE shop_meta_sync_items SET status=${status}, in_meta=${!!found}, pushed_hash=NULL, intent_key=NULL,
        meta_product_id=COALESCE(${metaId}::text, meta_product_id), error_code=NULL, error_detail=NULL, last_checked_at=${now},
        synced_at=CASE WHEN ${!!found} THEN ${now}::timestamptz ELSE synced_at END, updated_at=${now}
      WHERE account_id=${ctx.accountId}::uuid AND variant_id=${variantId}::uuid AND status='uncertain'`;
    if (!changed) throw new CatalogueError('conflict');
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.meta_sync_reconciled', variantId, { status });
    await queueMetaCatalogueSync(ctx.accountId, { tx, now });
  });
  return { status };
}
