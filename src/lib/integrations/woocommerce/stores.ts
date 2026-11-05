import { requireIntegrationRoom } from '@/lib/billing/limits';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { generateWooSecret } from './signature';

/**
 * WooCommerce store connections (table woocommerce_stores).
 *
 * The app role cannot SELECT webhook_secret_enc (column grants), so every row
 * the app functions return is safe for the browser. The plaintext secret
 * exists only in createWooStore's return value (shown to the admin once) and
 * in resolveWooStore, which runs as the worker for the public webhook.
 */

export interface WooStorePublic {
  id: string;
  store_url: string;
  consent_meta_key: string | null;
  connected_at: string;
}

export class WooStoreInputError extends Error {
  constructor(public readonly code: 'store_url_invalid' | 'consent_key_invalid' | 'store_exists' | 'store_limit') {
    super(code);
    this.name = 'WooStoreInputError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
export const MAX_WOO_STORES = 20;

/** "https://Shop.example.com/store/" → "https://shop.example.com/store". Null when not an http(s) URL. */
export function normalizeStoreUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 300) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || (!url.hostname.includes('.') && url.hostname !== 'localhost')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const out = `${url.protocol}//${url.host.toLowerCase()}${path}`;
  return out.length >= 10 && out.length <= 300 ? out : null;
}

export function normalizeConsentKey(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input !== 'string' || !CONSENT_KEY.test(input.trim())) throw new WooStoreInputError('consent_key_invalid');
  return input.trim();
}

type Row = { id: string; store_url: string; consent_meta_key: string | null; connected_at: Date };
const toPublic = (r: Row): WooStorePublic => ({
  id: r.id,
  store_url: r.store_url,
  consent_meta_key: r.consent_meta_key,
  connected_at: r.connected_at.toISOString(),
});

/** Stores of the account. `tx` is an app-role tenant transaction. */
export async function listWooStores(tx: TenantTransaction, accountId: string): Promise<WooStorePublic[]> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT id,store_url,consent_meta_key,connected_at FROM woocommerce_stores
    WHERE account_id=${accountId}::uuid ORDER BY created_at`;
  return rows.map(toPublic);
}

/**
 * Connects a store (admin; RLS refuses other roles). Returns the plaintext
 * webhook secret exactly once; only its encrypted form is stored.
 */
export async function createWooStore(
  tx: TenantTransaction,
  accountId: string,
  input: { storeUrl: unknown; consentMetaKey?: unknown },
): Promise<{ store: WooStorePublic; webhookSecret: string }> {
  const storeUrl = normalizeStoreUrl(input.storeUrl);
  if (!storeUrl) throw new WooStoreInputError('store_url_invalid');
  const consentMetaKey = normalizeConsentKey(input.consentMetaKey);
  const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM woocommerce_stores WHERE account_id=${accountId}::uuid`;
  if (count >= MAX_WOO_STORES) throw new WooStoreInputError('store_limit');
  await requireIntegrationRoom(tx, accountId);
  const webhookSecret = generateWooSecret();
  const rows = await tx.$queryRaw<Row[]>`
    INSERT INTO woocommerce_stores(account_id,store_url,webhook_secret_enc,consent_meta_key)
    VALUES(${accountId}::uuid,${storeUrl},${encrypt(webhookSecret)},${consentMetaKey})
    ON CONFLICT (account_id,store_url) DO NOTHING
    RETURNING id,store_url,consent_meta_key,connected_at`;
  if (!rows[0]) throw new WooStoreInputError('store_exists');
  return { store: toPublic(rows[0]), webhookSecret };
}

/** Changes the consent meta key. Null when the store is not the account's. */
export async function updateWooStoreConsentKey(
  tx: TenantTransaction, accountId: string, id: string, consentMetaKey: unknown,
): Promise<WooStorePublic | null> {
  if (!UUID.test(id)) return null;
  const key = normalizeConsentKey(consentMetaKey);
  const rows = await tx.$queryRaw<Row[]>`
    UPDATE woocommerce_stores SET consent_meta_key=${key}
    WHERE id=${id}::uuid AND account_id=${accountId}::uuid
    RETURNING id,store_url,consent_meta_key,connected_at`;
  return rows[0] ? toPublic(rows[0]) : null;
}

/**
 * Disconnects a store; its webhook URL stops working at once. The caller then
 * runs stopWooStore as the worker, so the store's queued sends stop too.
 */
export async function deleteWooStore(tx: TenantTransaction, accountId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const n = await tx.$executeRaw`DELETE FROM woocommerce_stores WHERE id=${id}::uuid AND account_id=${accountId}::uuid`;
  return n > 0;
}

/** True while the store row exists (app or worker tenant transaction). */
export async function wooStoreExists(tx: TenantTransaction, accountId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const rows = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM woocommerce_stores WHERE id=${id}::uuid AND account_id=${accountId}::uuid) AS found`;
  return rows[0]?.found === true;
}

/**
 * After a disconnect: skips the store's WooCommerce events still waiting to be
 * sent and, when the account has no WooCommerce store left, switches every
 * WooCommerce rule off so a later store does not start sending unreviewed.
 * An event whose outcome is unknown keeps its reconciliation reason.
 * Does nothing while the store still exists, so it is safe to repeat (a retried
 * DELETE that finds no row still finishes an interrupted cleanup).
 * `tx` must be a worker-role tenant transaction. Returns the events skipped.
 */
export async function stopWooStore(tx: TenantTransaction, accountId: string, id: string): Promise<number> {
  if (!UUID.test(id) || (await wooStoreExists(tx, accountId, id))) return 0;
  const prefix = `woocommerce:${id.toLowerCase()}:%`;
  const skipped = await tx.$executeRaw`
    UPDATE commerce_events SET status='skipped', reason='store_disconnected'
    WHERE account_id=${accountId}::uuid AND source='woocommerce' AND status='scheduled' AND reason IS NULL
      AND dedupe_key ILIKE ${prefix}`;
  await tx.$executeRaw`
    UPDATE commerce_event_rules SET enabled=false
    WHERE account_id=${accountId}::uuid AND source='woocommerce' AND enabled
      AND NOT EXISTS (SELECT 1 FROM woocommerce_stores WHERE account_id=${accountId}::uuid)`;
  return skipped;
}

export interface WooStoreSecret {
  accountId: string;
  storeId: string;
  storeUrl: string;
  consentMetaKey: string | null;
  secret: string;
}

/**
 * Server only (public webhook): the store's account and decrypted secret, or
 * null for an unknown store. Never return this to a browser or log it.
 */
export async function resolveWooStore(storeId: string): Promise<WooStoreSecret | null> {
  if (!UUID.test(storeId)) return null;
  const worker = getWorkerPrisma();
  const [found] = await worker.$queryRaw<{ account_id: string | null }[]>`
    SELECT resolve_woocommerce_store(${storeId}::uuid) AS account_id`;
  const accountId = found?.account_id;
  if (!accountId) return null;
  const row = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<
    { store_url: string; consent_meta_key: string | null; webhook_secret_enc: string }[]
  >`SELECT store_url,consent_meta_key,webhook_secret_enc FROM woocommerce_stores
    WHERE id=${storeId}::uuid AND account_id=${accountId}::uuid`, worker);
  if (!row[0]) return null;
  return {
    accountId,
    storeId: storeId.toLowerCase(),
    storeUrl: row[0].store_url,
    consentMetaKey: row[0].consent_meta_key,
    secret: decrypt(row[0].webhook_secret_enc),
  };
}
