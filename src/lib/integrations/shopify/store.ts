import { requireIntegrationRoom } from '@/lib/billing/limits';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { isShopDomain } from './oauth';

/**
 * shopify_stores access. The app role can read only the non-secret columns
 * (column grants), so every app-role query names its columns. The token is
 * decrypted only in loadShopifyToken, through the worker role, for a
 * server-side Shopify call; never return or log it.
 */

export interface ShopifyStorePublic {
  id: string;
  shop_domain: string;
  scopes: string;
  installed_at: Date;
  uninstalled_at: Date | null;
  marketing_opt_in_only: boolean;
}

export class ShopifyStoreError extends Error {
  constructor(public readonly reason: 'connected_elsewhere' | 'not_connected') {
    super(reason === 'connected_elsewhere' ? 'This store is connected to another workspace' : 'No Shopify store is connected');
    this.name = 'ShopifyStoreError';
  }
}

/**
 * The workspace's store: the installed one, else the most recently installed
 * shop still awaiting Shopify's shop/redact; null when none. A workspace keeps
 * one row per shop it has connected (at most one installed). `tx` is an
 * app-role tenant transaction.
 */
export async function getShopifyStore(tx: TenantTransaction, accountId: string): Promise<ShopifyStorePublic | null> {
  const rows = await tx.$queryRaw<ShopifyStorePublic[]>`
    SELECT id,shop_domain,scopes,installed_at,uninstalled_at,marketing_opt_in_only FROM shopify_stores WHERE account_id=${accountId}::uuid
    ORDER BY (uninstalled_at IS NULL) DESC, installed_at DESC, id LIMIT 1`;
  return rows[0] ?? null;
}

export interface ResolvedStore {
  account_id: string;
  store_id: string;
  active: boolean;
}

/** Workspaces holding `shop` (active install first). The one cross-tenant lookup, through a fixed definer function. */
export async function resolveShopifyStores(shop: string): Promise<ResolvedStore[]> {
  if (!isShopDomain(shop)) return [];
  return getWorkerPrisma().$queryRawUnsafe<ResolvedStore[]>('SELECT * FROM crm_resolve_shopify_store($1::text)', shop);
}

/**
 * Connects (or reconnects) the workspace's store after a verified OAuth
 * exchange. Admin only (RLS). Refuses a store installed in another workspace.
 * Connecting a different shop marks the previously installed shop's row
 * uninstalled (token cleared) but keeps it, so Shopify's customers/redact and
 * shop/redact for that shop still reach this workspace; the caller revokes the
 * old install on Shopify once this commits.
 */
export async function saveShopifyStore(
  tx: TenantTransaction,
  accountId: string,
  input: { shop: string; accessToken: string; scopes: string[] },
): Promise<ShopifyStorePublic> {
  if (!isShopDomain(input.shop) || !input.accessToken) throw new Error('Invalid Shopify store');
  const owners = await resolveShopifyStores(input.shop);
  if (owners.some((o) => o.active && o.account_id !== accountId)) throw new ShopifyStoreError('connected_elsewhere');
  const tokenEnc = encrypt(input.accessToken);
  const scopes = input.scopes.join(',').slice(0, 1000);
  await tx.$executeRaw`
    UPDATE shopify_stores SET uninstalled_at=now(), access_token_enc=NULL
    WHERE account_id=${accountId}::uuid AND shop_domain<>${input.shop} AND uninstalled_at IS NULL`;
  const updated = await tx.$executeRaw`
    UPDATE shopify_stores SET access_token_enc=${tokenEnc}, scopes=${scopes}, installed_at=now(), uninstalled_at=NULL
    WHERE account_id=${accountId}::uuid AND shop_domain=${input.shop}`;
  if (updated === 0) {
    // A new store takes a slot of the plan's integrations; replacing the installed shop frees its own first.
    await requireIntegrationRoom(tx, accountId);
    await tx.$executeRaw`
      INSERT INTO shopify_stores(account_id,shop_domain,access_token_enc,scopes) VALUES(${accountId}::uuid,${input.shop},${tokenEnc},${scopes})`;
  }
  const row = await getShopifyStore(tx, accountId);
  if (!row) throw new ShopifyStoreError('not_connected');
  return row;
}

/** Admin setting: marketing only to customers the store reports as subscribed. */
export async function setMarketingOptInOnly(tx: TenantTransaction, accountId: string, value: boolean): Promise<ShopifyStorePublic | null> {
  const store = await getShopifyStore(tx, accountId);
  if (!store) return null;
  await tx.$executeRaw`UPDATE shopify_stores SET marketing_opt_in_only=${value} WHERE account_id=${accountId}::uuid AND id=${store.id}::uuid`;
  return getShopifyStore(tx, accountId);
}

/** The active store's domain and decrypted token, or null. Server only. */
export async function loadShopifyToken(accountId: string): Promise<{ shop: string; accessToken: string } | null> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ shop_domain: string; access_token_enc: string | null }[]>`
    SELECT shop_domain,access_token_enc FROM shopify_stores WHERE account_id=${accountId}::uuid AND uninstalled_at IS NULL`, getWorkerPrisma());
  const row = rows[0];
  if (!row?.access_token_enc) return null;
  return { shop: row.shop_domain, accessToken: decrypt(row.access_token_enc) };
}

/**
 * Marks the store uninstalled and stops its automations: clears the token,
 * switches every Shopify rule off and skips Shopify events still waiting to be
 * sent (an event whose outcome is unknown keeps its reconciliation reason).
 * `tx` must be a worker-role tenant transaction. `before` ignores an uninstall
 * reported for an older install (a late redelivery after a reinstall).
 * Returns false when there was no active install to stop.
 */
export async function stopShopifyStore(tx: TenantTransaction, accountId: string, opts: { before?: Date | null } = {}): Promise<boolean> {
  const before = opts.before && !Number.isNaN(opts.before.getTime()) ? opts.before : null;
  const stopped = await tx.$executeRaw`
    UPDATE shopify_stores SET uninstalled_at=now(), access_token_enc=NULL
    WHERE account_id=${accountId}::uuid AND uninstalled_at IS NULL AND (${before}::timestamptz IS NULL OR installed_at <= ${before}::timestamptz)`;
  if (stopped === 0) return false;
  await tx.$executeRaw`UPDATE commerce_event_rules SET enabled=false WHERE account_id=${accountId}::uuid AND source='shopify' AND enabled`;
  await tx.$executeRaw`
    UPDATE commerce_events SET status='skipped', reason='store_disconnected'
    WHERE account_id=${accountId}::uuid AND source='shopify' AND status='scheduled' AND reason IS NULL`;
  return true;
}
