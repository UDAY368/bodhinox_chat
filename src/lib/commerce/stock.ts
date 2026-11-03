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

/** The tracked variants among `ids` (untracked ones are made to order and never counted). */
async function trackedIds(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM shop_variants
    WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[]) AND track_inventory`;
  return new Set(rows.map((r) => r.id));
}

async function movement(tx: TenantTransaction, accountId: string, m: {
  variantId: string; kind: StockMovementKind; quantity: number; level: LevelRow;
  orderId?: string | null; returnId?: string | null; reason?: string | null; actorUserId?: string | null;
}): Promise<void> {
  await tx.$executeRaw`INSERT INTO inventory_movements(account_id,variant_id,kind,quantity,on_hand_after,reserved_after,order_id,return_id,reason,actor_user_id)
    VALUES(${accountId}::uuid,${m.variantId}::uuid,${m.kind},${m.quantity},${m.level.on_hand},${m.level.reserved},
      ${m.orderId ?? null}::uuid,${m.returnId ?? null}::uuid,${m.reason?.slice(0, 200) ?? null},${m.actorUserId ?? null}::uuid)`;
}

/**
 * Reserve every tracked line for the order (ascending variant_id), held until
 * `expiresAt`. Throws StockError('out_of_stock', ..., variantId) when any line
 * cannot be reserved; the caller's transaction then rolls back as a whole.
 */
export async function reserveTx(
  tx: TenantTransaction, accountId: string, orderId: string, lines: StockLine[], expiresAt: Date,
): Promise<void> {
  const merged = mergeLines(lines);
  const tracked = await trackedIds(tx, accountId, merged.map((l) => l.variantId));
  for (const line of merged) {
    if (!tracked.has(line.variantId)) continue;
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET reserved = reserved + ${line.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${line.variantId}::uuid AND on_hand - reserved >= ${line.quantity}
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    if (!level) throw new StockError('out_of_stock', 'out_of_stock', line.variantId);
    await tx.$executeRaw`INSERT INTO stock_reservations(account_id,order_id,variant_id,quantity,status,expires_at)
      VALUES(${accountId}::uuid,${orderId}::uuid,${line.variantId}::uuid,${line.quantity},'held',${expiresAt})
      ON CONFLICT (account_id,order_id,variant_id) DO UPDATE SET quantity=EXCLUDED.quantity,status='held',expires_at=EXCLUDED.expires_at`;
    await movement(tx, accountId, { variantId: line.variantId, kind: 'reserve', quantity: line.quantity, level, orderId });
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
    if (level) await movement(tx, accountId, { variantId: r.variant_id, kind: 'release', quantity: -r.quantity, level, orderId, reason });
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
  await movement(tx, accountId, { variantId, kind, quantity: delta, level, reason: input.reason, actorUserId: input.actorUserId });
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
  const merged = mergeLines(input.lines);
  const tracked = await trackedIds(tx, accountId, merged.map((l) => l.variantId));
  for (const line of merged) {
    if (!tracked.has(line.variantId)) continue;
    await upsertLevel(tx, accountId, line.variantId);
    const [level] = await tx.$queryRaw<LevelRow[]>`
      UPDATE inventory_levels SET on_hand = on_hand + ${line.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${line.variantId}::uuid
      RETURNING variant_id::text AS variant_id, on_hand, reserved`;
    await movement(tx, accountId, {
      variantId: line.variantId, kind: input.kind, quantity: line.quantity, level: level!,
      orderId: input.orderId, returnId: input.returnId ?? null, actorUserId: input.actorUserId ?? null,
    });
    await maybeNotifyLowStockTx(tx, accountId, line.variantId);
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
