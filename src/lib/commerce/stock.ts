/**
 * Stock (design E5). The ONLY writer of inventory_levels, inventory_movements
 * and stock_reservations. Every function runs inside the caller's worker
 * transaction (withTenant(..., getWorkerPrisma())) so a stock change commits
 * with the order, payment or adjustment that caused it.
 *
 * Lock order everywhere: customer_payments row -> order row -> coupon row ->
 * inventory rows in ascending variant_id. Reservation is a conditional atomic
 * UPDATE (on_hand - reserved >= q); the table CHECK is the backstop. Under
 * READ COMMITTED a concurrent buyer waits on the row lock and re-evaluates the
 * WHERE against the committed row, so two buyers can never both take the last
 * unit.
 *
 * Movement quantities are signed: reserve +q and release -q change
 * `reserved`; sale, write_off and a negative adjustment are negative,
 * receipt, restocks and a positive adjustment positive, and those sum to
 * `on_hand`.
 */
import { getT } from '@/lib/i18n/translate';
import type { TenantTransaction } from '@/lib/db/tenant';
import { queueBackInStockTx } from './stock-alerts';
import { expandBundleLines, reserveFromStock, withinPreorderCap, type StockNeed } from './selling-rules';

export type StockMovementKind =
  | 'adjustment' | 'receipt' | 'reserve' | 'release' | 'sale' | 'return_restock' | 'write_off' | 'refund_restock';

export type StockErrorCode = 'out_of_stock' | 'below_reserved' | 'not_found' | 'invalid';
export class StockError extends Error {
  constructor(readonly code: StockErrorCode, message: string = code, readonly variantId?: string) {
    super(message);
    this.name = 'StockError';
  }
}

/** One order line's stock need; lines for untracked (made-to-order) variants are skipped by the module. */
export interface StockLine {
  variantId: string;
  quantity: number;
}

export interface StockLevel {
  variantId: string;
  onHand: number;
  reserved: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UNITS = 1_000_000;

interface LevelRow { variant_id: string; on_hand: number; reserved: number }

/** Merge repeated variants and order ascending by id (the lock order). */
function mergeLines(lines: readonly StockLine[]): StockLine[] {
  const merged = new Map<string, number>();
  for (const line of lines) {
    if (!UUID.test(line.variantId) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_UNITS)
      throw new StockError('invalid', 'invalid', line.variantId);
    merged.set(line.variantId.toLowerCase(), (merged.get(line.variantId.toLowerCase()) ?? 0) + line.quantity);
  }
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity })).sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
}

/** What stock needs to know about a variant: tracked or made to order, and its pre-order cap. */
interface VariantMeta { track: boolean; preorder: boolean; cap: number | null }

/**
 * A cart's stock needs by variant (ascending id, the lock order) with each variant's meta. A bundle line (a variant
 * of a bundle product) is replaced by its parts times the quantity, so the bundle reserves, and a return restocks,
 * every part and nothing of its own. A bundle with no parts, or with an archived part, cannot be taken
 * (StockError out_of_stock for the bundle variant).
 */
async function needsTx(tx: TenantTransaction, accountId: string, merged: readonly StockLine[], orderId: string | null = null): Promise<{ needs: StockNeed[]; meta: Map<string, VariantMeta> }> {
  const ids = merged.map((l) => l.variantId.toLowerCase());
  const bundleRows = ids.length ? await tx.$queryRaw<{ variant_id: string; part_id: string | null; quantity: number | null; part_archived: boolean | null }[]>`
    SELECT v.id::text AS variant_id, b.part_variant_id::text AS part_id, b.quantity, pv.archived_at IS NOT NULL AS part_archived
    FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id AND p.is_bundle
    LEFT JOIN shop_bundle_parts b ON b.account_id=v.account_id AND b.product_id=p.id
    LEFT JOIN shop_variants pv ON pv.account_id=b.account_id AND pv.id=b.part_variant_id
    WHERE v.account_id=${accountId}::uuid AND v.id = ANY(${ids}::uuid[])
    ORDER BY b.position, b.part_variant_id` : [];
  const parts = new Map<string, { variantId: string; quantity: number }[]>();
  for (const row of bundleRows) {
    const list = parts.get(row.variant_id) ?? [];
    if (!row.part_id || row.part_archived || !row.quantity) throw new StockError('out_of_stock', 'out_of_stock', row.variant_id);
    list.push({ variantId: row.part_id, quantity: row.quantity });
    parts.set(row.variant_id, list);
  }
  // An order's own snapshot wins over the bundle as it is now (a restock puts back what was sold).
  if (orderId && ids.length) {
    const sold = await tx.$queryRaw<{ variant_id: string; bundle_parts: { variant_id: string; quantity: number }[] }[]>`
      SELECT DISTINCT ON (variant_id) variant_id::text AS variant_id, bundle_parts FROM order_items
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND variant_id = ANY(${ids}::uuid[]) AND bundle_parts IS NOT NULL
      ORDER BY variant_id, id`;
    for (const row of sold) parts.set(row.variant_id, row.bundle_parts.map((p) => ({ variantId: p.variant_id, quantity: p.quantity })));
  }
  const needs = expandBundleLines(merged, (variantId) => parts.get(variantId) ?? null);
  const needIds = needs.map((n) => n.variantId);
  const rows = needIds.length ? await tx.$queryRaw<{ id: string; track: boolean; preorder: boolean; cap: number | null }[]>`
    SELECT id::text AS id, track_inventory AS track, preorder, preorder_cap AS cap FROM shop_variants
    WHERE account_id=${accountId}::uuid AND id = ANY(${needIds}::uuid[])` : [];
  return { needs, meta: new Map(rows.map((r) => [r.id, { track: r.track, preorder: r.preorder, cap: r.cap }])) };
}

/**
 * Pre-order caps: for every pre-order variant with a cap, lock its row (ascending, before the inventory rows)
 * and refuse when the open pre-order units, this order's own lines included (they are written before the
 * reservation), pass the cap. The lock makes two buyers of the last units take turns.
 */
async function assertPreorderCapsTx(tx: TenantTransaction, accountId: string, needs: readonly StockNeed[], meta: ReadonlyMap<string, VariantMeta>): Promise<void> {
  for (const need of needs) {
    const m = meta.get(need.variantId);
    if (!m?.preorder || m.cap === null || need.viaBundle >= need.quantity) continue;
    // NO KEY UPDATE: the order's own line rows hold a key-share lock on the variant (foreign key), which FOR UPDATE would deadlock on.
    await tx.$queryRaw`SELECT 1 FROM shop_variants WHERE account_id=${accountId}::uuid AND id=${need.variantId}::uuid FOR NO KEY UPDATE`;
    const [open] = await tx.$queryRaw<{ units: bigint }[]>`
      SELECT COALESCE(sum(i.quantity),0)::bigint AS units FROM order_items i
      JOIN orders o ON o.account_id=i.account_id AND o.id=i.order_id
      WHERE i.account_id=${accountId}::uuid AND i.variant_id=${need.variantId}::uuid AND i.preorder_ship_date IS NOT NULL
        AND o.status NOT IN ('expired','cancelled') AND o.refund_state <> 'full'`;
    if (!withinPreorderCap(m.cap, Number(open?.units ?? 0))) throw new StockError('out_of_stock', 'out_of_stock', need.variantId);
  }
}

async function movement(tx: TenantTransaction, accountId: string, m: {
  variantId: string; kind: StockMovementKind; quantity: number; level: LevelRow;
  orderId?: string | null; returnId?: string | null; reason?: string | null; actorUserId?: string | null;
}): Promise<string> {
  const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO inventory_movements(account_id,variant_id,kind,quantity,on_hand_after,reserved_after,order_id,return_id,reason,actor_user_id)
    VALUES(${accountId}::uuid,${m.variantId}::uuid,${m.kind},${m.quantity},${m.level.on_hand},${m.level.reserved},
      ${m.orderId ?? null}::uuid,${m.returnId ?? null}::uuid,${m.reason?.slice(0, 200) ?? null},${m.actorUserId ?? null}::uuid)
    RETURNING id::text AS id`;
  return row.id;
}

/**
 * A movement that raised available stock (on_hand - reserved) from nothing to something
 * wakes the back-in-stock alerts of the variant (dedupe: the movement id).
 */
async function wakeAlertsTx(tx: TenantTransaction, accountId: string, variantId: string, movementId: string,
  availableBefore: number, level: LevelRow): Promise<void> {
  if (availableBefore <= 0 && level.on_hand - level.reserved > 0) await queueBackInStockTx(tx, accountId, variantId, movementId);
}

/**
 * Reserve every tracked line for the order (ascending variant_id; a bundle line reserves its parts), held until
 * `expiresAt`, or with no expiry (null) for a cash-on-delivery order, which is
 * committed when the cash is recorded or released when it is cancelled.
 * Throws StockError('out_of_stock', ..., variantId) when any line cannot be
 * reserved; the caller's transaction then rolls back as a whole.
 */
export async function reserveTx(
  tx: TenantTransaction, accountId: string, orderId: string, lines: StockLine[], expiresAt: Date | null,
): Promise<void> {
  const { needs, meta } = await needsTx(tx, accountId, mergeLines(lines));
  await assertPreorderCapsTx(tx, accountId, needs, meta);
  for (const need of needs) {
    const m = meta.get(need.variantId);
    if (!m?.track) continue;
    let quantity = need.quantity;
    if (m.preorder) {
      // A pre-order variant sells past zero stock: reserve what is on the shelf, the rest is promised for the ship date.
      const [have] = await tx.$queryRaw<{ available: number }[]>`
        SELECT on_hand - reserved AS available FROM inventory_levels
        WHERE account_id=${accountId}::uuid AND variant_id=${need.variantId}::uuid FOR UPDATE`;
      const reserve = reserveFromStock(need, have?.available ?? 0, true);
      if (reserve === null) throw new StockError('out_of_stock', 'out_of_stock', need.variantId);
      if (reserve === 0) continue;
      quantity = reserve;
    }
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET reserved = reserved + ${quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${need.variantId}::uuid AND on_hand - reserved >= ${quantity}
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    if (!level) throw new StockError('out_of_stock', 'out_of_stock', need.variantId);
    await tx.$executeRaw`INSERT INTO stock_reservations(account_id,order_id,variant_id,quantity,status,expires_at)
      VALUES(${accountId}::uuid,${orderId}::uuid,${need.variantId}::uuid,${quantity},'held',${expiresAt})
      ON CONFLICT (account_id,order_id,variant_id) DO UPDATE SET quantity=EXCLUDED.quantity,status='held',expires_at=EXCLUDED.expires_at`;
    await movement(tx, accountId, { variantId: need.variantId, kind: 'reserve', quantity, level, orderId });
  }
}

/** The order's reservations in `status`, locked, in lock order. */
async function reservations(tx: TenantTransaction, accountId: string, orderId: string, status: 'held' | 'released') {
  return tx.$queryRaw<{ id: string; variant_id: string; quantity: number }[]>`
    SELECT id::text AS id, variant_id::text AS variant_id, quantity FROM stock_reservations
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND status=${status}
    ORDER BY variant_id FOR UPDATE`;
}

/** Release the order's held reservations (expiry, staff cancel). A no-op for none held. */
export async function releaseTx(
  tx: TenantTransaction, accountId: string, orderId: string, reason: 'expired' | 'cancelled' | 'replaced',
): Promise<void> {
  for (const r of await reservations(tx, accountId, orderId, 'held')) {
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET reserved = reserved - ${r.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${r.variant_id}::uuid
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    await tx.$executeRaw`UPDATE stock_reservations SET status='released' WHERE account_id=${accountId}::uuid AND id=${r.id}::uuid`;
    if (level) {
      const id = await movement(tx, accountId, { variantId: r.variant_id, kind: 'release', quantity: -r.quantity, level, orderId, reason });
      await wakeAlertsTx(tx, accountId, r.variant_id, id, level.on_hand - level.reserved - r.quantity, level);
    }
  }
}

/** Turn the order's held reservations into a sale (on_hand -= q, reserved -= q, 'sale' movements). */
export async function commitTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  for (const r of await reservations(tx, accountId, orderId, 'held')) {
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET on_hand = on_hand - ${r.quantity}, reserved = reserved - ${r.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${r.variant_id}::uuid
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    if (!level) throw new StockError('not_found', 'not_found', r.variant_id);
    await tx.$executeRaw`UPDATE stock_reservations SET status='committed', expires_at=NULL WHERE account_id=${accountId}::uuid AND id=${r.id}::uuid`;
    await movement(tx, accountId, { variantId: r.variant_id, kind: 'sale', quantity: -r.quantity, level, orderId });
    await maybeNotifyLowStockTx(tx, accountId, r.variant_id);
  }
}

/**
 * Reserve again the lines of an order whose hold was released (late payment).
 * Returns false, changing nothing, when any tracked line no longer has stock.
 */
export async function rereserveTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const released = await reservations(tx, accountId, orderId, 'released');
  if (!released.length) return true;
  const ids = released.map((r) => r.variant_id);
  // Lock every level first (ascending), check them all, then apply: all or nothing.
  const levels = await tx.$queryRaw<LevelRow[]>`
    SELECT variant_id::text AS variant_id, on_hand, reserved FROM inventory_levels
    WHERE account_id=${accountId}::uuid AND variant_id = ANY(${ids}::uuid[]) ORDER BY variant_id FOR UPDATE`;
  const byId = new Map(levels.map((l) => [l.variant_id, l]));
  if (released.some((r) => { const l = byId.get(r.variant_id); return !l || l.on_hand - l.reserved < r.quantity; })) return false;
  for (const r of released) {
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET reserved = reserved + ${r.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${r.variant_id}::uuid
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    await tx.$executeRaw`UPDATE stock_reservations SET status='held', expires_at=NULL WHERE account_id=${accountId}::uuid AND id=${r.id}::uuid`;
    await movement(tx, accountId, { variantId: r.variant_id, kind: 'reserve', quantity: r.quantity, level: level!, orderId, reason: 'late_payment' });
  }
  return true;
}

/** The tracked variants among `ids` (untracked ones are made to order and never counted). */
async function trackedIds(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM shop_variants
    WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[]) AND track_inventory`;
  return new Set(rows.map((r) => r.id));
}

/**
 * Order edit (never a bundle, pre-order or digital line: order-edits.ts refuses those): move what one order holds (an unpaid order: reserved) or sold (a paid order: on hand)
 * by `delta` units per variant, in ascending variant order. A positive delta needs that many units
 * available (StockError out_of_stock otherwise, and the caller's transaction rolls back); a negative
 * one gives units back. The order's reservation row follows, so a later commit, release or
 * cancel-and-refund restock reads the edited quantity. Untracked variants are skipped.
 */
export async function adjustOrderStockTx(tx: TenantTransaction, accountId: string, orderId: string,
  changes: ReadonlyArray<{ variantId: string; delta: number }>, opts: { committed: boolean; actorUserId?: string | null }): Promise<void> {
  const merged = new Map<string, number>();
  for (const c of changes) {
    if (!UUID.test(c.variantId) || !Number.isInteger(c.delta) || Math.abs(c.delta) > MAX_UNITS) throw new StockError('invalid', 'invalid', c.variantId);
    merged.set(c.variantId.toLowerCase(), (merged.get(c.variantId.toLowerCase()) ?? 0) + c.delta);
  }
  const ordered = [...merged].filter(([, delta]) => delta !== 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tracked = await trackedIds(tx, accountId, ordered.map(([id]) => id));
  const status = opts.committed ? 'committed' : 'held';
  for (const [variantId, delta] of ordered) {
    if (!tracked.has(variantId)) continue;
    const [row] = await tx.$queryRaw<{ id: string; quantity: number; status: string }[]>`
      SELECT id::text AS id, quantity, status FROM stock_reservations
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND variant_id=${variantId}::uuid FOR UPDATE`;
    const current = row && row.status === status ? row.quantity : 0;
    if (delta > 0) {
      const [level] = opts.committed
        ? await tx.$queryRaw<LevelRow[]>`UPDATE inventory_levels SET on_hand = on_hand - ${delta}
            WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid AND on_hand - reserved >= ${delta}
            RETURNING variant_id::text AS variant_id, on_hand, reserved`
        : await tx.$queryRaw<LevelRow[]>`UPDATE inventory_levels SET reserved = reserved + ${delta}
            WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid AND on_hand - reserved >= ${delta}
            RETURNING variant_id::text AS variant_id, on_hand, reserved`;
      if (!level) throw new StockError('out_of_stock', 'out_of_stock', variantId);
      await tx.$executeRaw`INSERT INTO stock_reservations(account_id,order_id,variant_id,quantity,status,expires_at)
        VALUES(${accountId}::uuid,${orderId}::uuid,${variantId}::uuid,${current + delta},${status},NULL)
        ON CONFLICT (account_id,order_id,variant_id) DO UPDATE SET quantity=EXCLUDED.quantity,status=EXCLUDED.status,expires_at=NULL`;
      await movement(tx, accountId, { variantId, kind: opts.committed ? 'sale' : 'reserve', quantity: opts.committed ? -delta : delta,
        level, orderId, reason: 'order_edit', actorUserId: opts.actorUserId ?? null });
      if (opts.committed) await maybeNotifyLowStockTx(tx, accountId, variantId);
      continue;
    }
    // Never gives back more than the order holds or sold of this variant.
    const back = Math.min(-delta, current);
    if (back <= 0 || !row) continue;
    const [level] = opts.committed
      ? await tx.$queryRaw<LevelRow[]>`UPDATE inventory_levels SET on_hand = on_hand + ${back}
          WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid
          RETURNING variant_id::text AS variant_id, on_hand, reserved`
      : await tx.$queryRaw<LevelRow[]>`UPDATE inventory_levels SET reserved = reserved - ${back}
          WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid
          RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    if (current - back > 0)
      await tx.$executeRaw`UPDATE stock_reservations SET quantity=${current - back} WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
    else
      await tx.$executeRaw`UPDATE stock_reservations SET status='released' WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
    if (!level) continue;
    const id = await movement(tx, accountId, { variantId, kind: opts.committed ? 'refund_restock' : 'release', quantity: opts.committed ? back : -back,
      level, orderId, reason: 'order_edit', actorUserId: opts.actorUserId ?? null });
    await wakeAlertsTx(tx, accountId, variantId, id, level.on_hand - level.reserved - back, level);
    if (opts.committed) await maybeNotifyLowStockTx(tx, accountId, variantId);
  }
}

async function upsertLevel(tx: TenantTransaction, accountId: string, variantId: string): Promise<void> {
  const [variant] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM shop_variants WHERE account_id=${accountId}::uuid AND id=${variantId}::uuid`;
  if (!variant) throw new StockError('not_found', 'not_found', variantId);
  await tx.$executeRaw`INSERT INTO inventory_levels(account_id,variant_id) VALUES(${accountId}::uuid,${variantId}::uuid)
    ON CONFLICT (account_id,variant_id) DO NOTHING`;
}

/**
 * Staff stock change: upserts the level row and writes the movement. Refuses
 * (StockError 'below_reserved') a result below what is reserved.
 */
export async function adjustTx(tx: TenantTransaction, accountId: string, input: {
  variantId: string;
  delta: number;
  kind: 'adjustment' | 'receipt' | 'write_off';
  reason: string | null;
  actorUserId: string | null;
}): Promise<StockLevel> {
  const { variantId, delta, kind } = input;
  if (!UUID.test(variantId) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_UNITS
    || (kind === 'receipt' && delta < 0) || (kind === 'write_off' && delta > 0)
    || (input.reason !== null && (typeof input.reason !== 'string' || input.reason.length > 200)))
    throw new StockError('invalid', 'invalid', variantId);
  await upsertLevel(tx, accountId, variantId);
  const [level] = await tx.$queryRaw<LevelRow[]>`
    UPDATE inventory_levels SET on_hand = on_hand + ${delta}
    WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid AND on_hand + ${delta} >= reserved AND on_hand + ${delta} <= ${MAX_UNITS}
    RETURNING variant_id::text AS variant_id, on_hand, reserved`;
  if (!level) throw new StockError('below_reserved', 'below_reserved', variantId);
  const movementId = await movement(tx, accountId, { variantId, kind, quantity: delta, level, reason: input.reason, actorUserId: input.actorUserId });
  await wakeAlertsTx(tx, accountId, variantId, movementId, level.on_hand - delta - level.reserved, level);
  await maybeNotifyLowStockTx(tx, accountId, variantId);
  return { variantId, onHand: level.on_hand, reserved: level.reserved };
}

/**
 * A variant's own low-stock threshold (null = the store default). Re-checks
 * the alert against the new threshold; the level row is created if needed.
 */
export async function setLowStockThresholdTx(tx: TenantTransaction, accountId: string, variantId: string, threshold: number | null): Promise<void> {
  if (!UUID.test(variantId) || (threshold !== null && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100_000)))
    throw new StockError('invalid', 'invalid', variantId);
  await upsertLevel(tx, accountId, variantId);
  await tx.$executeRaw`UPDATE inventory_levels SET low_stock_threshold=${threshold}
    WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid`;
  await maybeNotifyLowStockTx(tx, accountId, variantId);
}

/** Put returned or refunded units back on hand. */
export async function restockTx(tx: TenantTransaction, accountId: string, input: {
  orderId: string;
  lines: StockLine[];
  kind: 'return_restock' | 'refund_restock';
  returnId?: string | null;
  actorUserId?: string | null;
}): Promise<void> {
  // A bundle line puts its parts back; any other line puts back what it returns.
  const { needs, meta } = await needsTx(tx, accountId, mergeLines(input.lines), input.orderId);
  for (const need of needs) {
    if (!meta.get(need.variantId)?.track) continue;
    await upsertLevel(tx, accountId, need.variantId);
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET on_hand = on_hand + ${need.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${need.variantId}::uuid
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    const movementId = await movement(tx, accountId, {
      variantId: need.variantId, kind: input.kind, quantity: need.quantity, level: level!,
      orderId: input.orderId, returnId: input.returnId ?? null, actorUserId: input.actorUserId ?? null,
    });
    await wakeAlertsTx(tx, accountId, need.variantId, movementId, level!.on_hand - need.quantity - level!.reserved, level!);
    await maybeNotifyLowStockTx(tx, accountId, need.variantId);
  }
}

/**
 * Notify admins once when available stock falls to the threshold (dedupe
 * stock:<variant>:low:<epoch of low_notified_at>); reset when it rises above.
 */
export async function maybeNotifyLowStockTx(tx: TenantTransaction, accountId: string, variantId: string): Promise<void> {
  const [row] = await tx.$queryRaw<{ available: number; threshold: number; notified: boolean; name: string; sku: string; track: boolean }[]>`
    SELECT l.on_hand - l.reserved AS available,
      COALESCE(l.low_stock_threshold, s.low_stock_default, 5) AS threshold,
      l.low_notified_at IS NOT NULL AS notified, p.name, v.sku, v.track_inventory AS track
    FROM inventory_levels l
    JOIN shop_variants v ON v.account_id=l.account_id AND v.id=l.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN commerce_settings s ON s.account_id=l.account_id
    WHERE l.account_id=${accountId}::uuid AND l.variant_id=${variantId}::uuid`;
  if (!row || !row.track) return;
  if (row.available > row.threshold) {
    if (row.notified) await tx.$executeRaw`UPDATE inventory_levels SET low_notified_at=NULL
      WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid`;
    return;
  }
  if (row.notified) return;
  const [stamp] = await tx.$queryRaw<{ epoch: string }[]>`
    UPDATE inventory_levels SET low_notified_at=now() WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid
      AND low_notified_at IS NULL
    RETURNING floor(extract(epoch FROM low_notified_at))::bigint::text AS epoch`;
  if (!stamp) return;
  const t = getT('Commerce.lowStock');
  const title = t('title').slice(0, 200);
  const body = t('body', { product: row.name, sku: row.sku, available: Math.max(0, row.available) }).slice(0, 1000);
  const dedupeKey = `stock:${variantId}:low:${stamp.epoch}`;
  const admins = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM account_memberships WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') LIMIT 200`;
  for (const { user_id } of admins)
    await tx.$executeRaw`INSERT INTO notifications(account_id,user_id,type,title,body,link,dedupe_key)
      VALUES(${accountId}::uuid,${user_id}::uuid,'low_stock',${title},${body},'/commerce/catalogue',${dedupeKey})
      ON CONFLICT DO NOTHING`;
}
