// GET  /api/commerce/shop/platform-import — admins: which stores are connected (never a credential), whether Shopify granted
//      read_products, and the latest imports with their progress. 200 { status }.
// POST /api/commerce/shop/platform-import (admins) — queue an import of the connected store's products as drafts.
//      { platform: 'shopify' } or { platform: 'woocommerce', store_id, consumer_key, consumer_secret } (typed for this import,
//      kept encrypted until the job ends). 202 { import_id }. 409 platform_not_connected / shopify_scope_missing / woo_https_required / import_running.
export const runtime = 'nodejs';

import { platformStatus, queuePlatformImport, type PlatformImportInput } from '@/lib/commerce/catalogue/platform-import-job';
import { asBody, CatalogueError, isId } from '@/lib/commerce/catalogue/products';
import { catalogueErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin' });
    return json({ status: await inTenant(caller, (tx) => platformStatus(tx, caller.accountId)) });
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}

function parseInput(raw: unknown): PlatformImportInput {
  const b = asBody(raw);
  if (b.platform === 'shopify') return { platform: 'shopify' };
  if (b.platform !== 'woocommerce') throw new CatalogueError('invalid', 'platform');
  if (!isId(b.store_id)) throw new CatalogueError('invalid', 'store_id');
  if (typeof b.consumer_key !== 'string') throw new CatalogueError('invalid', 'consumer_key');
  if (typeof b.consumer_secret !== 'string') throw new CatalogueError('invalid', 'consumer_secret');
  return { platform: 'woocommerce', storeId: b.store_id, consumerKey: b.consumer_key.trim(), consumerSecret: b.consumer_secret.trim() };
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const input = parseInput(await readJson(request));
    return json(await queuePlatformImport({ ...caller.tenant, userId: caller.userId }, input), 202);
  } catch (error) {
    return catalogueErrorResponse(error);
  }
}
