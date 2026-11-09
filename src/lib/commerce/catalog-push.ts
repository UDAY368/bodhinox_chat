/**
 * Worker job 'commerce.catalog_push' (audit finding 20): pushes the price and
 * availability of linked variants to their Meta catalogue, so a WhatsApp cart
 * cannot be placed for an item that is sold out or repriced in Bodhinox.
 *
 * A variant is linked when a mirrored Meta product of the catalogue has
 * retailer_id = its SKU (the same rule as the Meta link panel and checkout).
 * Its availability is what checkout sells: 'in stock' when the product is
 * published, the variant not archived and either stock is not tracked or
 * on_hand - reserved > 0; otherwise 'out of stock'. Its price is the variant
 * price in the store currency (left alone while the variant has no price).
 *
 * Queued (see migration 20261116080003_catalog_push_triggers) in the same
 * transaction as any change that can move a linked item's price or
 * availability, at most once a minute per workspace, and after every complete
 * catalogue sync (the periodic reconcile). The job compares Bodhinox with the
 * mirror (the last state read from, or pushed to, Meta) and sends only the
 * differences, as absolute values, so a repeated push is harmless. After Meta
 * accepts a batch the mirror is updated to what was sent; the next six-hour
 * sync reads Meta's own state back, and a difference left there is pushed
 * again. Only while Bodhinox is the seller of record: checkout enabled and the
 * plan's storefront feature (otherwise WhatsApp orders are handled by hand and
 * the Meta catalogue stays the seller's own; enabling checkout queues a push).
 * Meta failures throw, so the job retries with backoff and stays
 * visible as failed; the next sync queues a fresh push. Tokens, product names
 * and prices are never logged.
 */

import { getEntitlements } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt } from '@/lib/whatsapp/encryption';
import { CATALOG_BATCH_MAX, updateCatalogItems, type MetaCatalogItemUpdate } from '@/lib/whatsapp/meta-api';
import { CatalogError, loadCatalogNumber } from './catalog';
import { minorFromDb, minorToDecimalString } from './money';

export const CATALOG_PUSH_JOB = 'commerce.catalog_push';
/** Items per job run per catalogue; a larger backlog is finished by the next run (queued below). */
export const CATALOG_PUSH_MAX_ITEMS = 5 * CATALOG_BATCH_MAX;

export type CatalogUpdater = typeof updateCatalogItems;

export interface LinkedItemState {
  retailer_id: string;
  meta_price_minor: number | null;
  meta_currency: string | null;
  meta_availability: string | null;
  price_minor: number | null;
  currency: string | null;
  sellable: boolean;
}

/** What to send for one linked item, or null when Meta already shows Bodhinox's price and availability. */
export function itemUpdate(item: LinkedItemState): MetaCatalogItemUpdate | null {
  const availability = item.sellable ? 'in stock' : 'out of stock';
  const update: MetaCatalogItemUpdate = { retailerId: item.retailer_id };
  if (item.price_minor !== null && item.currency
    && (item.meta_price_minor !== item.price_minor || item.meta_currency !== item.currency)) {
    update.price = `${minorToDecimalString(item.price_minor, item.currency)} ${item.currency}`;
  }
  if (item.meta_availability !== availability) update.availability = availability;
  return update.price || update.availability ? update : null;
}

const worker = <T>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> =>
  withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

async function linkedItems(tx: TenantTransaction, accountId: string, catalogRowId: string): Promise<LinkedItemState[]> {
  const rows = await tx.$queryRaw<{ retailer_id: string; meta_price: bigint | null; meta_currency: string | null; meta_availability: string | null;
    price: bigint | null; currency: string | null; sellable: boolean }[]>`
    SELECT m.retailer_id, m.price_minor AS meta_price, m.currency AS meta_currency, m.availability AS meta_availability,
      v.price_minor AS price, st.currency,
      (p.status='published' AND v.archived_at IS NULL AND (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0)) AS sellable
    FROM products m
    JOIN shop_variants v ON v.account_id=m.account_id AND v.sku=m.retailer_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    LEFT JOIN commerce_settings st ON st.account_id=m.account_id
    WHERE m.account_id=${accountId}::uuid AND m.catalog_row_id=${catalogRowId}::uuid AND NOT m.is_hidden
    ORDER BY m.retailer_id`;
  return rows.map((r) => ({
    retailer_id: r.retailer_id, meta_price_minor: minorFromDb(r.meta_price), meta_currency: r.meta_currency,
    meta_availability: r.meta_availability, price_minor: minorFromDb(r.price), currency: r.currency, sellable: r.sellable,
  }));
}

export interface CatalogPushResult {
  catalogs: number;
  pushed: number;
  skipped: number;
}

/** Pushes every linked catalogue's differences. Throws on a Meta failure (the job retries). */
export async function pushCatalogChanges(accountId: string, update: CatalogUpdater = updateCatalogItems): Promise<CatalogPushResult> {
  const result: CatalogPushResult = { catalogs: 0, pushed: 0, skipped: 0 };
  // Bodhinox's prices and stock decide only where its checkout sells: a workspace that takes WhatsApp orders by
  // hand (checkout off, or a plan without the storefront) keeps Meta's catalogue as its own.
  const sells = await worker(accountId, async (tx) => {
    const [settings] = await tx.$queryRaw<{ checkout_enabled: boolean }[]>`
      SELECT checkout_enabled FROM commerce_settings WHERE account_id=${accountId}::uuid`;
    return !!settings?.checkout_enabled && !!(await getEntitlements(tx, accountId)).features.storefront;
  });
  if (!sells) return result;
  const catalogs = await worker(accountId, (tx) => tx.$queryRaw<{ id: string; catalog_id: string; whatsapp_config_id: string | null }[]>`
    SELECT id::text AS id, catalog_id, whatsapp_config_id::text AS whatsapp_config_id FROM whatsapp_catalogs
    WHERE account_id=${accountId}::uuid ORDER BY created_at`);
  let failure: unknown = null;
  for (const catalog of catalogs) {
    const loaded = await worker(accountId, async (tx) => {
      let number;
      try {
        number = await loadCatalogNumber(tx, accountId, catalog.whatsapp_config_id);
      } catch (error) {
        if (error instanceof CatalogError) return null;
        throw error;
      }
      return { number, items: await linkedItems(tx, accountId, catalog.id) };
    });
    // No usable number: the catalogue's own sync records number_unavailable; nothing can be pushed.
    if (!loaded) { result.skipped += 1; continue; }
    const updates = loaded.items.map(itemUpdate).filter((u): u is MetaCatalogItemUpdate => u !== null);
    result.catalogs += 1;
    if (!updates.length) continue;
    const accessToken = decrypt(loaded.number.accessTokenEnc);
    const byRetailer = new Map(loaded.items.map((i) => [i.retailer_id, i]));
    const batchable = updates.slice(0, CATALOG_PUSH_MAX_ITEMS);
    try {
      for (let i = 0; i < batchable.length; i += CATALOG_BATCH_MAX) {
        const batch = batchable.slice(i, i + CATALOG_BATCH_MAX);
        await update({ catalogId: catalog.catalog_id, accessToken, items: batch });
        // Meta accepted the batch: the mirror now holds what was sent, so it is not sent again.
        await worker(accountId, async (tx) => {
          for (const item of batch) {
            const state = byRetailer.get(item.retailerId)!;
            await tx.$executeRaw`UPDATE products SET
                price_minor=CASE WHEN ${item.price !== undefined} THEN ${state.price_minor === null ? null : BigInt(state.price_minor)}::bigint ELSE price_minor END,
                currency=CASE WHEN ${item.price !== undefined} THEN ${state.currency}::text ELSE currency END,
                availability=COALESCE(${item.availability ?? null}::text, availability)
              WHERE account_id=${accountId}::uuid AND catalog_row_id=${catalog.id}::uuid AND retailer_id=${item.retailerId}`;
          }
        });
        result.pushed += batch.length;
      }
    } catch (error) {
      // One catalogue's failure does not stop the others; the job fails afterwards and retries.
      failure ??= error;
      continue;
    }
    // More differences than one run sends: the next minute's run continues.
    if (updates.length > batchable.length) await queueCatalogPush(accountId);
  }
  if (failure) throw failure;
  return result;
}

/** Queues a push for the next minute (deduped per workspace per minute), outside a change transaction. */
export async function queueCatalogPush(accountId: string, tx?: TenantTransaction, now: Date = new Date()): Promise<void> {
  const slot = Math.floor(now.getTime() / 60_000);
  const runAt = new Date((slot + 1) * 60_000);
  const insert = (db: TenantTransaction) => db.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${CATALOG_PUSH_JOB},${accountId}::uuid,'{}'::jsonb,${`catalog-push:${accountId}:${slot}`},${runAt},3)
    ON CONFLICT(dedupe_key) DO NOTHING`;
  if (tx) await insert(tx);
  else await worker(accountId, insert);
}

/** Job entry point (registered in lib/jobs/handlers.ts). */
export async function handleCatalogPushJob(accountId: string): Promise<void> {
  await pushCatalogChanges(accountId);
}
