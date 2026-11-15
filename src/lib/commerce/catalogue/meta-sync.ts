/**
 * Full Meta catalogue sync (store plan Phase 4, package 4): the pure rules.
 * What one variant looks like as a Meta catalogue item, how items are batched,
 * what a failed send or a batch status means for each item, and when to back
 * off. No network here; see meta-sync-job.ts for the job.
 *
 * The one rule everything else follows: an UPDATE of an item that already
 * exists is absolute and may be sent again, but a CREATE whose outcome is not
 * known (timeout, network error, 5xx, a batch status Meta cannot explain) is
 * 'uncertain' and is never sent again until an admin reconciles it.
 * (queueMetaSyncIn is the one statement here that touches a transaction.)
 */

import { createHash } from 'node:crypto';
import { MetaApiError, type MetaBatchStatus, type MetaCatalogItemData, type MetaUsage } from '@/lib/whatsapp/meta-api';
import type { TenantTransaction } from '@/lib/db/tenant';
import { minorToDecimalString } from '../money';

export const META_SYNC_JOB = 'commerce.meta_catalogue_sync';

/**
 * Queues a run in the caller's transaction (one per workspace per minute) when
 * the workspace has opted in; otherwise nothing. The same key shape as the
 * database triggers of migration 20261129030000_meta_catalogue_full_sync.
 */
export async function queueMetaSyncIn(tx: TenantTransaction, accountId: string, options: { delayMs?: number; now?: Date } = {}): Promise<void> {
  const slot = Math.floor(((options.now ?? new Date()).getTime() + (options.delayMs ?? 0)) / 60_000);
  const runAt = new Date((slot + 1) * 60_000);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    SELECT ${META_SYNC_JOB}::text,${accountId}::uuid,'{}'::jsonb,${`meta-catalogue-sync:${accountId}:${slot}`}::text,${runAt}::timestamptz,3
    WHERE EXISTS (SELECT 1 FROM shop_meta_sync_settings s WHERE s.account_id=${accountId}::uuid AND s.enabled)
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Items per items_batch call (whole items are much larger than a price update). */
export const META_SYNC_BATCH_MAX = 500;
/** Batches one job run sends; a larger backlog continues in the next run. */
export const META_SYNC_MAX_BATCHES_PER_RUN = 4;
/** Per-workspace cap: batches claimed in any rolling hour. */
export const META_SYNC_HOURLY_BATCH_CAP = 40;
/** Batch handles one run polls. */
export const META_SYNC_MAX_POLLS_PER_RUN = 10;
/** A batch Meta still reports as running after this long is treated as an unknown outcome. */
export const META_SYNC_PENDING_MAX_MS = 60 * 60_000;
/** Stop sending when Meta reports this much of the rate budget used. */
export const META_USAGE_STOP_PERCENT = 90;
/** Graph throttling codes: app (4), user (17), page (32), custom (613), business use case (80014). */
export const META_RATE_LIMIT_CODES: readonly number[] = [4, 17, 32, 613, 80014];

export type MetaSyncStatus = 'not_synced' | 'pending' | 'synced' | 'failed' | 'uncertain';
export type MetaSyncMethod = 'CREATE' | 'UPDATE';
/** Why an item was not sent, decided here before any call to Meta. */
export type LocalRefusal = 'missing_price' | 'missing_image' | 'missing_link';

export interface SyncVariant {
  variant_id: string;
  product_id: string;
  sku: string;
  name: string;
  description: string | null;
  brand: string | null;
  option_values: Record<string, string>;
  price_minor: number | null;
  currency: string | null;
  /** What checkout sells: published, not archived, and in stock or not tracked. */
  sellable: boolean;
  /** The variant's picture, or the product's first one. */
  image: { id: string; url: string | null } | null;
}

export interface SyncContext {
  /** Meta's catalogue id. */
  catalogId: string;
  /** The app's public https origin, or null when it is not https (Meta needs https links). */
  origin: string | null;
  /** The published public shop's handle, or null when the shop is not published. */
  handle: string | null;
}

export type ItemBuild =
  | { ok: true; data: MetaCatalogItemData; hash: string }
  | { ok: false; code: LocalRefusal; hash: string };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

/** One variant as a Meta item, with a digest of exactly what would be sent (it changes when anything Meta shows changes). */
export function buildMetaItem(v: SyncVariant, ctx: SyncContext): ItemBuild {
  const refuse = (code: LocalRefusal): ItemBuild => ({ ok: false, code, hash: sha256(JSON.stringify(['refused', ctx.catalogId, v.sku, code])) });
  if (v.price_minor === null || !v.currency) return refuse('missing_price');
  if (!ctx.origin || !ctx.handle) return refuse('missing_link');
  if (!v.image) return refuse('missing_image');
  const options = Object.entries(v.option_values ?? {}).filter(([, value]) => typeof value === 'string' && value.trim());
  const suffix = options.map(([, value]) => value.trim()).join(' / ');
  const title = clip(suffix ? `${v.name.trim()} - ${suffix}` : v.name.trim(), 200);
  const option = (name: string) => options.find(([key]) => key.trim().toLowerCase() === name)?.[1].trim();
  // An https picture URL is sent as it is; a library picture goes through the shop's public image route.
  const direct = v.image.url && /^https:\/\//i.test(v.image.url) ? v.image.url : null;
  const color = option('color') ?? option('colour');
  const size = option('size');
  const brand = v.brand?.trim();
  const data: MetaCatalogItemData = {
    id: v.sku,
    title,
    description: clip(v.description?.trim() || title, 9999),
    availability: v.sellable ? 'in stock' : 'out of stock',
    condition: 'new',
    price: `${minorToDecimalString(v.price_minor, v.currency)} ${v.currency}`,
    link: `${ctx.origin}/s/${ctx.handle}/p/${v.product_id}`,
    image_link: direct ?? `${ctx.origin}/api/public/store/${ctx.handle}/images/${v.image.id}`,
    ...(brand ? { brand: clip(brand, 100) } : {}),
    item_group_id: v.product_id,
    ...(color ? { color: clip(color, 100) } : {}),
    ...(size ? { size: clip(size, 100) } : {}),
  };
  return { ok: true, data, hash: sha256(JSON.stringify([ctx.catalogId, data])) };
}

export function chunk<T>(items: T[], size: number = META_SYNC_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The stable intent key of one batch: catalogue, method and a digest of each
 * item's SKU, content digest and attempt number. The same batch planned twice
 * (a replayed job, two overlapping runs) has the same key and is claimed once;
 * a later resend of the same content has a higher attempt and a new key.
 */
export function batchIntentKey(accountId: string, catalogId: string, method: MetaSyncMethod,
  items: { retailerId: string; hash: string; attempts: number }[]): string {
  const lines = items.map((i) => `${i.retailerId}:${i.hash}:${i.attempts}`).sort();
  return `${accountId}:meta-catalogue:${catalogId}:${method.toLowerCase()}:${sha256(lines.join('\n'))}`;
}

export interface ItemState {
  status: MetaSyncStatus;
  catalog_id: string;
  retailer_id: string;
  pushed_hash: string | null;
  in_meta: boolean;
  error_code: string | null;
}

export type PlanAction = { kind: 'skip' } | { kind: 'refuse'; code: LocalRefusal } | { kind: 'send'; method: MetaSyncMethod };

/**
 * What to do with one variant. `mirrored`: the last catalogue sync read an item
 * with this SKU from Meta. `force` (an admin's "Sync now") sends failed items
 * again; otherwise a failed item waits until its content changes. Uncertain
 * and pending items are never planned.
 */
export function planItem(row: ItemState | null, build: ItemBuild, ctx: { catalogId: string; sku: string; mirrored: boolean; force: boolean }): PlanAction {
  if (row?.status === 'uncertain' || row?.status === 'pending') return { kind: 'skip' };
  const sameTarget = !!row && row.catalog_id === ctx.catalogId && row.retailer_id === ctx.sku;
  if (!build.ok) {
    return sameTarget && row!.status === 'failed' && row!.error_code === build.code ? { kind: 'skip' } : { kind: 'refuse', code: build.code };
  }
  if (sameTarget && row!.pushed_hash === build.hash) {
    if (row!.status === 'synced') return { kind: 'skip' };
    if (row!.status === 'failed' && !ctx.force) return { kind: 'skip' };
  }
  return { kind: 'send', method: ctx.mirrored || (sameTarget && row!.in_meta) ? 'UPDATE' : 'CREATE' };
}

export type SendFailure =
  /** Meta throttled the call before applying it: nothing was sent; wait, then plan again. */
  | { kind: 'rate_limited'; delayMs: number }
  /** Meta refused the call (4xx): nothing was applied. `stop`: the token or permission is wrong, so no other batch can work. */
  | { kind: 'rejected'; code: 'token_invalid' | 'catalog_permission' | 'meta_rejected'; detail: string | null; stop: boolean }
  /** An UPDATE whose outcome is unknown: it is absolute, so it is simply sent again. */
  | { kind: 'retryable' }
  /** A CREATE whose outcome is unknown: never sent again until reconciled. */
  | { kind: 'uncertain' };

export const isRateLimit = (error: unknown): error is MetaApiError =>
  error instanceof MetaApiError && (error.httpStatus === 429 || (error.code !== null && META_RATE_LIMIT_CODES.includes(error.code)));

/** Minutes-scale backoff for a throttled call: 5, 10, 20 ... capped at an hour. */
export const rateLimitDelayMs = (attempt: number): number => Math.min(5 * 60_000 * 2 ** Math.max(attempt - 1, 0), 60 * 60_000);

/** What a failed items_batch call means for the items in it. */
export function classifySendError(error: unknown, method: MetaSyncMethod, attempt = 1): SendFailure {
  if (isRateLimit(error)) return { kind: 'rate_limited', delayMs: rateLimitDelayMs(attempt) };
  if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
    // Meta's numeric codes only, never its text.
    const detail = error.code === null ? null : `${error.code}${error.subcode === null ? '' : `/${error.subcode}`}`;
    if (error.code === 190 || error.httpStatus === 401) return { kind: 'rejected', code: 'token_invalid', detail, stop: true };
    if (error.code === 10 || error.code === 3 || (error.code !== null && error.code >= 200 && error.code <= 299) || error.httpStatus === 403)
      return { kind: 'rejected', code: 'catalog_permission', detail, stop: true };
    return { kind: 'rejected', code: 'meta_rejected', detail, stop: false };
  }
  // A timeout, a dropped connection, a 5xx or anything unexpected: Meta may or may not have taken the batch.
  return method === 'UPDATE' ? { kind: 'retryable' } : { kind: 'uncertain' };
}

/** How long to stop sending after a successful call, from Meta's usage header; null to carry on. */
export function usageBackoffMs(usage: MetaUsage | null): number | null {
  if (!usage) return null;
  if (usage.regainMinutes > 0) return Math.min(Math.ceil(usage.regainMinutes) * 60_000, 60 * 60_000);
  return usage.percent >= META_USAGE_STOP_PERCENT ? 10 * 60_000 : null;
}

export type ItemOutcome = 'synced' | 'failed' | 'wait' | 'retry' | 'uncertain';

/**
 * What a batch status means for one item of that batch.
 *   finished           synced, or failed when Meta lists the item as invalid; when Meta reports more
 *                      errors than it lists, an unlisted item is unknown (below)
 *   started            wait, until the batch is older than META_SYNC_PENDING_MAX_MS, then unknown
 *   anything else      unknown ('error', 'canceled', a handle Meta does not know, a new status)
 * Unknown: an UPDATE is sent again ('retry'); a CREATE is 'uncertain'.
 */
export function interpretBatchStatus(status: MetaBatchStatus, item: { retailerId: string; method: MetaSyncMethod }, ageMs: number): ItemOutcome {
  const unknown: ItemOutcome = item.method === 'UPDATE' ? 'retry' : 'uncertain';
  if (status.status === 'finished') {
    if (status.invalidIds.includes(item.retailerId)) return 'failed';
    return status.errorsTruncated ? unknown : 'synced';
  }
  if (status.status === 'started' || status.status === 'in_progress') return ageMs > META_SYNC_PENDING_MAX_MS ? unknown : 'wait';
  return unknown;
}
