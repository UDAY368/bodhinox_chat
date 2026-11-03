/**
 * Inventory screens and staff stock adjustments (design E5, section 3).
 *
 * Reads run on the app role (agents and above; RLS). Every stock write goes
 * through lib/commerce/stock.ts on the worker role: adjustStock checks the
 * member's role and the commerce.inventory permission, then audits and calls
 * stock.adjustTx in one worker transaction carrying the actor's user id.
 *
 * A retried request must not adjust twice, so the caller states the on-hand
 * count it saw (expected_on_hand). The level is locked first; a different
 * count refuses with stock_changed and the screen reloads.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { adjustTx, setLowStockThresholdTx, StockError, type StockLevel } from '../stock';
import { likePattern } from '../catalog';
import { asBody, auditCatalogue, CatalogueError, has, int, isId } from './products';

export const ADJUST_KINDS = ['adjustment', 'receipt', 'write_off'] as const;
export type AdjustKind = (typeof ADJUST_KINDS)[number];
export const INVENTORY_FILTERS = ['low', 'out'] as const;
export type InventoryFilter = (typeof INVENTORY_FILTERS)[number];
export const MOVEMENT_KINDS = ['adjustment', 'receipt', 'reserve', 'release', 'sale', 'return_restock', 'write_off', 'refund_restock'] as const;
/** Largest single adjustment (and the largest count a level can hold in practice). */
export const MAX_ADJUST = 1_000_000;

export interface InventoryRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  product_status: string;
  sku: string;
  option_values: Record<string, string>;
  on_hand: number;
  reserved: number;
  available: number;
  low_stock_threshold: number;
  low: boolean;
  updated_at: string | null;
}

export interface InventoryQuery {
  q?: string;
  filter?: InventoryFilter;
  limit?: number;
  offset?: number;
}

export function parseInventoryQuery(params: URLSearchParams): InventoryQuery {
  const q = (params.get('q') ?? '').trim().slice(0, 100);
  const filter = params.get('filter') ?? '';
  const limit = Number(params.get('limit') ?? 50), offset = Number(params.get('offset') ?? 0);
  return {
    q: q || undefined,
    filter: (INVENTORY_FILTERS as readonly string[]).includes(filter) ? (filter as InventoryFilter) : undefined,
    limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    offset: Number.isInteger(offset) ? Math.min(Math.max(offset, 0), 100_000) : 0,
  };
}

type LevelRow = Omit<InventoryRow, 'on_hand' | 'reserved' | 'available' | 'low_stock_threshold' | 'updated_at' | 'low'> & {
  on_hand: number; reserved: number; threshold: number; updated_at: Date | null; total: bigint;
};

/** Tracked, active variants with their stock; low = available at or below the threshold. */
export async function listInventory(tx: TenantTransaction, accountId: string, query: InventoryQuery = {}):
  Promise<{ items: InventoryRow[]; total: number }> {
  const pattern = query.q ? likePattern(query.q) : null;
  const filter = query.filter ?? null;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = await tx.$queryRaw<LevelRow[]>`
    SELECT v.id::text AS variant_id, p.id::text AS product_id, p.name AS product_name, p.status AS product_status, v.sku, v.option_values,
      COALESCE(l.on_hand,0) AS on_hand, COALESCE(l.reserved,0) AS reserved,
      COALESCE(l.low_stock_threshold, st.low_stock_default, 5) AS threshold, l.updated_at, count(*) OVER() AS total
    FROM shop_variants v
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    LEFT JOIN commerce_settings st ON st.account_id=v.account_id
    WHERE v.account_id=${accountId}::uuid AND v.archived_at IS NULL AND v.track_inventory AND p.status<>'archived'
      AND (${pattern}::text IS NULL OR p.name ILIKE ${pattern} OR v.sku ILIKE ${pattern})
      AND (${filter}::text IS NULL
        OR (${filter}='out' AND COALESCE(l.on_hand,0)-COALESCE(l.reserved,0) <= 0)
        OR (${filter}='low' AND COALESCE(l.on_hand,0)-COALESCE(l.reserved,0) <= COALESCE(l.low_stock_threshold, st.low_stock_default, 5)))
    ORDER BY COALESCE(l.on_hand,0)-COALESCE(l.reserved,0), lower(p.name), v.sku
    LIMIT ${limit} OFFSET ${offset}`;
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length && offset > 0) total = (await listInventory(tx, accountId, { ...query, offset: 0, limit: 1 })).total;
  return {
    total,
    items: rows.map(({ threshold, total: _t, updated_at, ...r }) => {
      void _t;
      const available = Math.max(r.on_hand - r.reserved, 0);
      return { ...r, option_values: (r.option_values ?? {}) as Record<string, string>, available,
        low_stock_threshold: threshold, low: available <= threshold, updated_at: updated_at ? updated_at.toISOString() : null };
    }),
  };
}

export interface MovementRow {
  id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  kind: (typeof MOVEMENT_KINDS)[number];
  quantity: number;
  on_hand_after: number;
  reserved_after: number;
  order_id: string | null;
  return_id: string | null;
  reason: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  created_at: string;
}

export interface MovementQuery {
  variantId?: string;
  /** Keyset: movements strictly older than this one. */
  before?: { createdAt: string; id: string };
  limit?: number;
}

export function parseMovementQuery(params: URLSearchParams): MovementQuery {
  const variant = params.get('variant_id') ?? '';
  const limit = Number(params.get('limit') ?? 50);
  const cursor = params.get('before') ?? '';
  const [at, id] = cursor.split('|');
  const before = at && isId(id) && !Number.isNaN(Date.parse(at)) ? { createdAt: new Date(at).toISOString(), id } : undefined;
  return { variantId: isId(variant) ? variant : undefined, before, limit: Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50 };
}

/** The append-only ledger, newest first. `next` is the cursor for the following page. */
export async function listMovements(tx: TenantTransaction, accountId: string, query: MovementQuery = {}):
  Promise<{ movements: MovementRow[]; next: string | null }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const variantId = query.variantId ?? null;
  const beforeAt = query.before?.createdAt ?? null, beforeId = query.before?.id ?? null;
  const rows = await tx.$queryRaw<(Omit<MovementRow, 'created_at'> & { created_at: Date; cursor_at: string })[]>`
    SELECT m.id::text AS id, m.variant_id::text AS variant_id, v.sku, p.name AS product_name, m.kind, m.quantity, m.on_hand_after,
      m.reserved_after, m.order_id::text AS order_id, m.return_id::text AS return_id, m.reason, m.actor_user_id::text AS actor_user_id,
      (SELECT pr.full_name FROM profiles pr WHERE pr.user_id=m.actor_user_id LIMIT 1) AS actor_name, m.created_at,
      to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM inventory_movements m
    JOIN shop_variants v ON v.account_id=m.account_id AND v.id=m.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE m.account_id=${accountId}::uuid
      AND (${variantId}::uuid IS NULL OR m.variant_id=${variantId}::uuid)
      AND (${beforeAt}::timestamptz IS NULL OR (m.created_at, m.id) < (${beforeAt}::timestamptz, ${beforeId}::uuid))
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    movements: page.map(({ cursor_at: _c, ...r }) => { void _c; return { ...r, created_at: r.created_at.toISOString() }; }),
    next: rows.length > limit && last ? `${last.cursor_at}|${last.id}` : null,
  };
}

export interface AdjustInput {
  variantId: string;
  delta: number;
  kind: AdjustKind;
  reason: string | null;
  expectedOnHand: number;
}

/** Body: { delta, kind, reason?, expected_on_hand }. Receipts add, write-offs remove, adjustments go either way. */
export function parseAdjustInput(variantId: string, raw: unknown): AdjustInput {
  if (!isId(variantId)) throw new CatalogueError('not_found');
  const b = asBody(raw);
  const kind = b.kind;
  if (!(ADJUST_KINDS as readonly unknown[]).includes(kind)) throw new CatalogueError('invalid', 'kind');
  const delta = int(b, 'delta', -MAX_ADJUST, MAX_ADJUST);
  if (delta === 0 || (kind === 'receipt' && delta < 0) || (kind === 'write_off' && delta > 0)) throw new CatalogueError('invalid', 'delta');
  const expectedOnHand = int(b, 'expected_on_hand', 0, 2_147_483_647);
  let reason: string | null = null;
  if (has(b, 'reason') && b.reason !== null && b.reason !== '') {
    if (typeof b.reason !== 'string' || b.reason.trim().length > 200) throw new CatalogueError('invalid', 'reason');
    reason = b.reason.trim() || null;
  }
  if (kind === 'write_off' && !reason) throw new CatalogueError('invalid', 'reason');
  return { variantId, delta, kind: kind as AdjustKind, reason, expectedOnHand };
}

/**
 * Staff stock change (design: requirePermission('commerce.inventory') + audit +
 * stock.adjustTx in one worker transaction). Refuses an untracked or archived
 * variant (not_tracked), a stale count (stock_changed) and a result below what
 * is reserved for open orders (below_reserved).
 */
export async function adjustStock(ctx: TenantContext & { userId: string }, input: AdjustInput): Promise<StockLevel> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    const variant = await tx.$queryRaw<{ track_inventory: boolean; archived: boolean }[]>`
      SELECT track_inventory, archived_at IS NOT NULL AS archived FROM shop_variants
      WHERE account_id=${ctx.accountId}::uuid AND id=${input.variantId}::uuid`;
    if (!variant[0]) throw new CatalogueError('not_found');
    if (!variant[0].track_inventory || variant[0].archived) throw new CatalogueError('not_tracked');
    // Serialise adjustments of one variant even before its level row exists, then lock the row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-adjust:${ctx.accountId}:${input.variantId}`}, 0))`;
    const level = await tx.$queryRaw<{ on_hand: number }[]>`SELECT on_hand FROM inventory_levels
      WHERE account_id=${ctx.accountId}::uuid AND variant_id=${input.variantId}::uuid FOR UPDATE`;
    if ((level[0]?.on_hand ?? 0) !== input.expectedOnHand) throw new CatalogueError('stock_changed');
    let result: StockLevel;
    try {
      result = await adjustTx(tx, ctx.accountId, {
        variantId: input.variantId, delta: input.delta, kind: input.kind, reason: input.reason, actorUserId: ctx.userId,
      });
    } catch (error) {
      if (error instanceof StockError && error.code === 'below_reserved') throw new CatalogueError('below_reserved');
      if (error instanceof StockError && error.code === 'not_found') throw new CatalogueError('not_found');
      if (error instanceof StockError && error.code === 'invalid') throw new CatalogueError('invalid', 'delta');
      throw error;
    }
    // The reason is staff-entered stock wording; the audit keeps codes and counts only.
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.stock_adjusted', input.variantId,
      { kind: input.kind, delta: input.delta, on_hand_after: result.onHand });
    return result;
  }, getWorkerPrisma());
}

/** Body of PUT .../threshold: { low_stock_threshold: 0..100000 | null } (null = the store default). */
export function parseThresholdInput(variantId: string, raw: unknown): { variantId: string; threshold: number | null } {
  if (!isId(variantId)) throw new CatalogueError('not_found');
  const b = asBody(raw);
  if (!has(b, 'low_stock_threshold')) throw new CatalogueError('invalid', 'low_stock_threshold');
  if (b.low_stock_threshold === null) return { variantId, threshold: null };
  return { variantId, threshold: int(b, 'low_stock_threshold', 0, 100_000) };
}

/** Set a tracked variant's own low-stock threshold (commerce.inventory, audited, written by stock.ts). */
export async function setLowStockThreshold(ctx: TenantContext & { userId: string }, input: { variantId: string; threshold: number | null }): Promise<void> {
  await requirePermission(ctx, 'commerce.inventory');
  await withTenant(ctx, async (tx) => {
    const variant = await tx.$queryRaw<{ track_inventory: boolean; archived: boolean }[]>`
      SELECT track_inventory, archived_at IS NOT NULL AS archived FROM shop_variants
      WHERE account_id=${ctx.accountId}::uuid AND id=${input.variantId}::uuid`;
    if (!variant[0]) throw new CatalogueError('not_found');
    if (!variant[0].track_inventory || variant[0].archived) throw new CatalogueError('not_tracked');
    try {
      await setLowStockThresholdTx(tx, ctx.accountId, input.variantId, input.threshold);
    } catch (error) {
      if (error instanceof StockError && error.code === 'not_found') throw new CatalogueError('not_found');
      if (error instanceof StockError && error.code === 'invalid') throw new CatalogueError('invalid', 'low_stock_threshold');
      throw error;
    }
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.stock_threshold_set', input.variantId, { threshold: input.threshold });
  }, getWorkerPrisma());
}
