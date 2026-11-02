/**
 * WhatsApp catalogues and their mirrored products.
 *
 * A catalogue is Meta's (Commerce Manager); a workspace links one to one of its
 * numbers, which turns on the cart and catalogue button for that number
 * (whatsapp_commerce_settings). Products are mirrored by the worker job in
 * catalog-sync.ts, every six hours and on demand, so the inbox and flows can
 * pick products without calling Meta.
 *
 * Tenancy: every query runs in a withTenant transaction of the caller, so RLS
 * applies (members read; admins write whatsapp_catalogs and products). The
 * access token is read only server side, decrypted just before a Meta call,
 * and never returned or logged.
 */

import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getWabaCatalogs, MetaApiError, setCommerceSettings } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { minorFromDb } from './money';

export const CATALOG_SYNC_JOB = 'commerce.catalog_sync';
export const CATALOG_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^[0-9]{1,32}$/;

export type CatalogErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'number_unavailable'
  | 'no_waba'
  | 'catalog_not_in_waba'
  | 'number_has_catalog'
  | 'meta_error';

const STATUS: Record<CatalogErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  number_unavailable: 409,
  no_waba: 409,
  catalog_not_in_waba: 409,
  number_has_catalog: 409,
  meta_error: 502,
};

/** A refusal with a translated message (Validation.catalog.<code>) and an HTTP status. */
export class CatalogError extends Error {
  readonly status: number;
  constructor(readonly code: CatalogErrorCode) {
    super(getT('Validation.catalog')(code));
    this.name = 'CatalogError';
    this.status = STATUS[code];
  }
}

/** Fixed sync failure categories stored on whatsapp_catalogs.sync_error (Commerce.catalog.syncErrors.*). */
export type CatalogSyncError = 'number_unavailable' | 'token' | 'not_found' | 'unavailable' | 'too_many_products';

/** A linked catalogue as the browser sees it: no token, no key material. */
export interface CatalogPublic {
  id: string;
  catalog_id: string;
  name: string;
  whatsapp_config_id: string | null;
  number_label: string | null;
  is_cart_enabled: boolean;
  is_catalog_visible: boolean;
  last_synced_at: string | null;
  sync_error: string | null;
  created_at: string;
  product_count: number;
}

export interface ProductPublic {
  id: string;
  catalog_row_id: string;
  retailer_id: string;
  name: string;
  description: string | null;
  price_minor: number | null;
  currency: string | null;
  image_url: string | null;
  url: string | null;
  availability: string | null;
  is_hidden: boolean;
  synced_at: string;
}

export interface MetaCatalogChoice {
  id: string;
  name: string;
  /** Already linked in this workspace (to this or another number). */
  linked: boolean;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

type CatalogRow = {
  id: string; catalog_id: string; name: string; whatsapp_config_id: string | null; display_name: string | null;
  phone_number_id: string | null; is_cart_enabled: boolean; is_catalog_visible: boolean; last_synced_at: Date | null;
  sync_error: string | null; created_at: Date; product_count: number | bigint;
};

function toPublic(row: CatalogRow): CatalogPublic {
  return {
    id: row.id,
    catalog_id: row.catalog_id,
    name: row.name,
    whatsapp_config_id: row.whatsapp_config_id,
    number_label: row.display_name || row.phone_number_id || null,
    is_cart_enabled: row.is_cart_enabled,
    is_catalog_visible: row.is_catalog_visible,
    last_synced_at: iso(row.last_synced_at),
    sync_error: row.sync_error,
    created_at: iso(row.created_at)!,
    product_count: Number(row.product_count),
  };
}

async function catalogRows(tx: TenantTransaction, accountId: string, id: string | null): Promise<CatalogPublic[]> {
  const rows = await tx.$queryRaw<CatalogRow[]>`
    SELECT c.id::text AS id,c.catalog_id,c.name,c.whatsapp_config_id::text AS whatsapp_config_id,w.display_name,w.phone_number_id,
      c.is_cart_enabled,c.is_catalog_visible,c.last_synced_at,c.sync_error,c.created_at,
      (SELECT count(*) FROM products p WHERE p.account_id=c.account_id AND p.catalog_row_id=c.id AND NOT p.is_hidden) AS product_count
    FROM whatsapp_catalogs c
    LEFT JOIN whatsapp_config w ON w.account_id=c.account_id AND w.id=c.whatsapp_config_id
    WHERE c.account_id=${accountId}::uuid AND (${id}::uuid IS NULL OR c.id=${id}::uuid)
    ORDER BY c.created_at ASC, c.id ASC`;
  return rows.map(toPublic);
}

/** Every linked catalogue with its count of visible products (any member). */
export function listCatalogs(tx: TenantTransaction, accountId: string): Promise<CatalogPublic[]> {
  return catalogRows(tx, accountId, null);
}

export async function getCatalog(tx: TenantTransaction, accountId: string, id: string): Promise<CatalogPublic | null> {
  if (!UUID.test(id)) return null;
  return (await catalogRows(tx, accountId, id))[0] ?? null;
}

export interface SendingNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string | null;
  /** Still encrypted; decrypt just before the Meta call. */
  accessTokenEnc: string;
}

/**
 * A connected number of this workspace, or CatalogError('number_unavailable').
 * `configId` null means the workspace default. Never falls back from a named
 * number to another one.
 */
export async function loadCatalogNumber(tx: TenantTransaction, accountId: string, configId: string | null): Promise<SendingNumber> {
  try {
    const row = await getNumberConfig(tx, accountId, configId);
    if (isNumberDisconnected(row) || !row.phone_number_id || !row.access_token) throw new CatalogError('number_unavailable');
    return { id: row.id, phoneNumberId: row.phone_number_id, wabaId: row.waba_id ?? null, accessTokenEnc: row.access_token };
  } catch (error) {
    if (error instanceof NoNumberError) throw new CatalogError('number_unavailable');
    throw error;
  }
}

/**
 * Catalogue writes and Meta calls are for admins. Routes check this too; it is
 * repeated here because the Meta side effect happens before RLS would refuse
 * the row write.
 */
function assertAdmin(ctx: TenantContext): void {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
}

function metaFailure(error: unknown): never {
  if (error instanceof CatalogError) throw error;
  if (error instanceof MetaApiError || (error instanceof Error && error.name === 'TimeoutError')) throw new CatalogError('meta_error');
  throw error;
}

/** The catalogues of a number's WhatsApp Business Account, for the connect picker (admin). */
export async function listMetaCatalogs(ctx: TenantContext, configId: string): Promise<MetaCatalogChoice[]> {
  assertAdmin(ctx);
  if (!UUID.test(configId)) throw new CatalogError('invalid_input');
  const { number, linked } = await withTenant(ctx, async (tx) => {
    const number = await loadCatalogNumber(tx, ctx.accountId, configId);
    const rows = await tx.whatsapp_catalogs.findMany({ where: { account_id: ctx.accountId }, select: { catalog_id: true } });
    return { number, linked: new Set(rows.map((r) => r.catalog_id)) };
  });
  if (!number.wabaId || !META_ID.test(number.wabaId)) throw new CatalogError('no_waba');
  try {
    const catalogs = await getWabaCatalogs({ wabaId: number.wabaId, accessToken: decrypt(number.accessTokenEnc) });
    return catalogs.filter((c) => META_ID.test(c.id)).map((c) => ({ id: c.id, name: c.name.slice(0, 200), linked: linked.has(c.id) }));
  } catch (error) {
    return metaFailure(error);
  }
}

export interface ConnectCatalogInput {
  whatsappConfigId: string;
  catalogId: string;
  isCartEnabled: boolean;
  isCatalogVisible: boolean;
}

/** Validates a POST body; throws CatalogError('invalid_input'). */
export function parseConnectInput(body: unknown): ConnectCatalogInput {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const configId = typeof b.whatsapp_config_id === 'string' ? b.whatsapp_config_id : '';
  const catalogId = typeof b.catalog_id === 'string' ? b.catalog_id.trim() : '';
  if (!UUID.test(configId) || !META_ID.test(catalogId)) throw new CatalogError('invalid_input');
  for (const key of ['is_cart_enabled', 'is_catalog_visible']) {
    if (b[key] !== undefined && typeof b[key] !== 'boolean') throw new CatalogError('invalid_input');
  }
  return {
    whatsappConfigId: configId,
    catalogId,
    isCartEnabled: b.is_cart_enabled !== false,
    isCatalogVisible: b.is_catalog_visible !== false,
  };
}

/** Validates a PATCH body: at least one of the two switches. */
export function parseSettingsInput(body: unknown): { isCartEnabled?: boolean; isCatalogVisible?: boolean } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: { isCartEnabled?: boolean; isCatalogVisible?: boolean } = {};
  if (b.is_cart_enabled !== undefined) {
    if (typeof b.is_cart_enabled !== 'boolean') throw new CatalogError('invalid_input');
    out.isCartEnabled = b.is_cart_enabled;
  }
  if (b.is_catalog_visible !== undefined) {
    if (typeof b.is_catalog_visible !== 'boolean') throw new CatalogError('invalid_input');
    out.isCatalogVisible = b.is_catalog_visible;
  }
  if (out.isCartEnabled === undefined && out.isCatalogVisible === undefined) throw new CatalogError('invalid_input');
  return out;
}

/**
 * Per-catalogue offset inside the six-hour cycle, so every workspace's
 * catalogues do not all sync at the same instant.
 */
export function catalogSyncOffsetMs(catalogRowId: string): number {
  let hash = 0;
  for (const ch of catalogRowId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % CATALOG_SYNC_INTERVAL_MS;
}

/** The next periodic slot after `now`: its index (for the dedupe key) and its start. */
export function nextCatalogSyncSlot(catalogRowId: string, now: number): { slot: number; runAt: Date } {
  const offset = catalogSyncOffsetMs(catalogRowId);
  const slot = Math.floor((now - offset) / CATALOG_SYNC_INTERVAL_MS) + 1;
  return { slot, runAt: new Date(slot * CATALOG_SYNC_INTERVAL_MS + offset) };
}

/**
 * Queues a sync of one catalogue in the caller's transaction (app role for an
 * admin's "Sync now", worker role for the periodic chain), so the job is
 * durable before the request is acknowledged. `periodic` queues the next
 * six-hour slot; `manual` runs now, at most once per catalogue per minute.
 */
export async function queueCatalogSync(tx: TenantTransaction, accountId: string, catalogRowId: string,
  kind: 'manual' | 'periodic', now: number = Date.now()): Promise<{ dedupeKey: string; runAt: Date }> {
  const { slot, runAt } = kind === 'periodic'
    ? nextCatalogSyncSlot(catalogRowId, now)
    : { slot: Math.floor(now / 60_000), runAt: new Date(now) };
  const dedupeKey = `catalog-sync:${catalogRowId}:${kind === 'periodic' ? 'p' : 'm'}:${slot}`;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${CATALOG_SYNC_JOB},${accountId}::uuid,${JSON.stringify({ catalogId: catalogRowId })}::jsonb,${dedupeKey},${runAt},3)
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return { dedupeKey, runAt };
}

/** A Postgres unique violation (23505), as raw or as Prisma wraps it from $queryRaw. */
function isUniqueViolation(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null;
  if (!failure || typeof failure !== 'object') return false;
  return failure.code === '23505' || failure.code === 'P2002' || failure.meta?.code === '23505'
    || failure.meta?.driverAdapterError?.cause?.originalCode === '23505';
}

/**
 * Links a Meta catalogue to a number (admin): checks that the catalogue
 * belongs to the number's WABA, applies the cart / visibility settings on
 * Meta, stores the link and queues the first sync in the same transaction.
 * Re-linking the same catalogue moves it to the given number. A number can
 * hold one catalogue; unlink the old one first.
 */
export async function connectCatalog(ctx: TenantContext, input: ConnectCatalogInput): Promise<CatalogPublic> {
  assertAdmin(ctx);
  const number = await withTenant(ctx, async (tx) => {
    const number = await loadCatalogNumber(tx, ctx.accountId, input.whatsappConfigId);
    const other = await tx.whatsapp_catalogs.findFirst({
      where: { account_id: ctx.accountId, whatsapp_config_id: number.id, NOT: { catalog_id: input.catalogId } },
      select: { id: true },
    });
    if (other) throw new CatalogError('number_has_catalog');
    return number;
  });
  if (!number.wabaId || !META_ID.test(number.wabaId)) throw new CatalogError('no_waba');
  let name = '';
  try {
    const accessToken = decrypt(number.accessTokenEnc);
    const owned = (await getWabaCatalogs({ wabaId: number.wabaId, accessToken })).find((c) => c.id === input.catalogId);
    if (!owned) throw new CatalogError('catalog_not_in_waba');
    name = owned.name.slice(0, 200);
    await setCommerceSettings({ phoneNumberId: number.phoneNumberId, accessToken,
      isCartEnabled: input.isCartEnabled, isCatalogVisible: input.isCatalogVisible });
  } catch (error) {
    metaFailure(error);
  }
  return withTenant(ctx, async (tx) => {
    const other = await tx.whatsapp_catalogs.findFirst({
      where: { account_id: ctx.accountId, whatsapp_config_id: number.id, NOT: { catalog_id: input.catalogId } },
      select: { id: true },
    });
    if (other) throw new CatalogError('number_has_catalog');
    // The check above is only the friendly path: a concurrent connect of another
    // catalogue to this number can commit between it and the insert, and the
    // partial unique index whatsapp_catalogs_one_per_number is what refuses it.
    let rows: { id: string }[];
    try {
      rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO whatsapp_catalogs(account_id,whatsapp_config_id,catalog_id,name,is_cart_enabled,is_catalog_visible)
        VALUES(${ctx.accountId}::uuid,${number.id}::uuid,${input.catalogId},${name},${input.isCartEnabled},${input.isCatalogVisible})
        ON CONFLICT(account_id,catalog_id) DO UPDATE SET whatsapp_config_id=EXCLUDED.whatsapp_config_id,name=EXCLUDED.name,
          is_cart_enabled=EXCLUDED.is_cart_enabled,is_catalog_visible=EXCLUDED.is_catalog_visible
        RETURNING id::text AS id`;
    } catch (error) {
      if (isUniqueViolation(error)) throw new CatalogError('number_has_catalog');
      throw error;
    }
    await queueCatalogSync(tx, ctx.accountId, rows[0].id, 'manual');
    return (await catalogRows(tx, ctx.accountId, rows[0].id))[0];
  });
}

/** Changes the cart / catalogue-button switches on Meta, then stores them (admin). */
export async function updateCatalogSettings(ctx: TenantContext, id: string,
  patch: { isCartEnabled?: boolean; isCatalogVisible?: boolean }): Promise<CatalogPublic> {
  assertAdmin(ctx);
  if (!UUID.test(id)) throw new CatalogError('not_found');
  const { catalog, number } = await withTenant(ctx, async (tx) => {
    const catalog = (await catalogRows(tx, ctx.accountId, id))[0];
    if (!catalog) throw new CatalogError('not_found');
    if (!catalog.whatsapp_config_id) throw new CatalogError('number_unavailable');
    return { catalog, number: await loadCatalogNumber(tx, ctx.accountId, catalog.whatsapp_config_id) };
  });
  const next = {
    isCartEnabled: patch.isCartEnabled ?? catalog.is_cart_enabled,
    isCatalogVisible: patch.isCatalogVisible ?? catalog.is_catalog_visible,
  };
  try {
    await setCommerceSettings({ phoneNumberId: number.phoneNumberId, accessToken: decrypt(number.accessTokenEnc), ...next });
  } catch (error) {
    metaFailure(error);
  }
  return withTenant(ctx, async (tx) => {
    const updated = await tx.whatsapp_catalogs.updateMany({
      where: { account_id: ctx.accountId, id },
      data: { is_cart_enabled: next.isCartEnabled, is_catalog_visible: next.isCatalogVisible },
    });
    if (!updated.count) throw new CatalogError('not_found');
    return (await catalogRows(tx, ctx.accountId, id))[0];
  });
}

/**
 * Unlinks a catalogue in this workspace (admin) and drops its mirrored
 * products. The catalogue itself and the number's commerce settings on Meta
 * are left as they are.
 */
export async function deleteCatalog(tx: TenantTransaction, accountId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const deleted = await tx.whatsapp_catalogs.deleteMany({ where: { account_id: accountId, id } });
  return deleted.count > 0;
}

/** Sync now (admin): queues the job; the page shows the result when it lands. */
export async function requestCatalogSync(ctx: TenantContext, id: string): Promise<void> {
  assertAdmin(ctx);
  if (!UUID.test(id)) throw new CatalogError('not_found');
  await withTenant(ctx, async (tx) => {
    const row = await tx.whatsapp_catalogs.findFirst({ where: { account_id: ctx.accountId, id }, select: { id: true } });
    if (!row) throw new CatalogError('not_found');
    await queueCatalogSync(tx, ctx.accountId, id, 'manual');
  });
}

// ---------------------------------------------------------------------------
// Products

export const PRODUCT_AVAILABILITY_FILTERS = ['in_stock', 'out_of_stock', 'other'] as const;
export type ProductAvailabilityFilter = (typeof PRODUCT_AVAILABILITY_FILTERS)[number];

export interface ProductQuery {
  q?: string;
  availability?: ProductAvailabilityFilter;
  catalogRowId?: string;
  /** Only the catalogue linked to this number. */
  whatsappConfigId?: string;
  /** Only the catalogue of the number this conversation sends from (the inbox picker). */
  conversationId?: string;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
}

/** Reads the products page's query string; unknown values are ignored, never echoed. */
export function parseProductQuery(params: URLSearchParams): ProductQuery {
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const availability = params.get('availability');
  const catalog = params.get('catalog_id') ?? '';
  const number = params.get('whatsapp_config_id') ?? '';
  const conversation = params.get('conversation_id') ?? '';
  const limit = Number(params.get('limit') ?? 50);
  const offset = Number(params.get('offset') ?? 0);
  return {
    q: q || undefined,
    availability: (PRODUCT_AVAILABILITY_FILTERS as readonly string[]).includes(availability ?? '')
      ? (availability as ProductAvailabilityFilter) : undefined,
    catalogRowId: UUID.test(catalog) ? catalog : undefined,
    whatsappConfigId: UUID.test(number) ? number : undefined,
    conversationId: UUID.test(conversation) ? conversation : undefined,
    includeHidden: params.get('hidden') === '1',
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    offset: Number.isInteger(offset) ? Math.min(Math.max(offset, 0), 100_000) : 0,
  };
}

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The number a conversation sends from (the default for a legacy one), or null. */
async function conversationNumberId(tx: TenantTransaction, accountId: string, conversationId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
    SELECT whatsapp_config_id::text AS whatsapp_config_id FROM conversations
    WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
  if (!rows[0]) return null;
  try {
    return (await getNumberConfig(tx, accountId, rows[0].whatsapp_config_id)).id;
  } catch (error) {
    if (error instanceof NoNumberError) return null;
    throw error;
  }
}

type ProductRow = Omit<ProductPublic, 'price_minor' | 'synced_at'> & { price_minor: bigint | null; synced_at: Date };

/** A page of mirrored products by name, with the total for paging (any member). */
export async function listProducts(tx: TenantTransaction, accountId: string, query: ProductQuery = {}):
  Promise<{ products: ProductPublic[]; total: number }> {
  if (query.conversationId) {
    const numberId = await conversationNumberId(tx, accountId, query.conversationId);
    if (!numberId) return { products: [], total: 0 };
    return listProducts(tx, accountId, { ...query, conversationId: undefined, whatsappConfigId: numberId });
  }
  const pattern = query.q ? likePattern(query.q) : null;
  const availability = query.availability ?? null;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = await tx.$queryRaw<(ProductRow & { total: bigint })[]>`
    SELECT p.id::text AS id,p.catalog_row_id::text AS catalog_row_id,p.retailer_id,p.name,p.description,p.price_minor,p.currency,
      p.image_url,p.url,p.availability,p.is_hidden,p.synced_at,count(*) OVER() AS total
    FROM products p JOIN whatsapp_catalogs c ON c.account_id=p.account_id AND c.id=p.catalog_row_id
    WHERE p.account_id=${accountId}::uuid
      AND (${query.includeHidden === true} OR NOT p.is_hidden)
      AND (${query.catalogRowId ?? null}::uuid IS NULL OR p.catalog_row_id=${query.catalogRowId ?? null}::uuid)
      AND (${query.whatsappConfigId ?? null}::uuid IS NULL OR c.whatsapp_config_id=${query.whatsappConfigId ?? null}::uuid)
      AND (${pattern}::text IS NULL OR p.name ILIKE ${pattern} OR p.retailer_id ILIKE ${pattern})
      AND (${availability}::text IS NULL
        OR (${availability}='in_stock' AND lower(p.availability)='in stock')
        OR (${availability}='out_of_stock' AND lower(p.availability)='out of stock')
        OR (${availability}='other' AND (p.availability IS NULL OR lower(p.availability) NOT IN ('in stock','out of stock'))))
    ORDER BY lower(p.name) ASC, p.id ASC
    LIMIT ${limit} OFFSET ${offset}`;
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length && offset > 0) {
    const counted = await listProducts(tx, accountId, { ...query, offset: 0, limit: 1 });
    total = counted.total;
  }
  return {
    total,
    products: rows.map((row) => ({
      id: row.id,
      catalog_row_id: row.catalog_row_id,
      retailer_id: row.retailer_id,
      name: row.name,
      description: row.description,
      price_minor: minorFromDb(row.price_minor),
      currency: row.currency,
      image_url: row.image_url,
      url: row.url,
      availability: row.availability,
      is_hidden: row.is_hidden,
      synced_at: iso(row.synced_at)!,
    })),
  };
}
