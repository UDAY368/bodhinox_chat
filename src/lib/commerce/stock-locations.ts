/**
 * Stock locations and transfers (store plan Phase 8).
 *
 * inventory_levels.on_hand stays the one sellable total that checkout reserves against (stock.ts).
 * Every workspace has one default location, made on first use, that holds whatever is not counted
 * elsewhere: default quantity = on_hand - sum(stock_location_levels). Only the other locations have
 * rows, so the locations always sum to the total. The database enforces it (migration
 * 20261201001000): a location row cannot push the sum above on_hand, and when on_hand falls below the
 * sum (a sale, a write-off) the shortfall leaves the other locations in position order.
 *
 * Writes run on the worker role after the member's role and the commerce.inventory permission were
 * checked, like every other stock write. Lock order: the variant's inventory_levels row first, then
 * its location rows; a transfer never changes on_hand or reserved.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { asBody, auditCatalogue, CatalogueError, has, isId } from './catalogue/products';
import { defaultLocationQuantity, transferProblem } from './stock-rules';

export interface StockLocation {
  id: string;
  name: string;
  is_default: boolean;
  active: boolean;
  position: number;
  /** Units of every variant held here. */
  units: number;
}

export interface LocationQuantity {
  location_id: string;
  name: string;
  is_default: boolean;
  active: boolean;
  quantity: number;
}

export interface StockTransfer {
  id: string;
  from_location_id: string;
  to_location_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  quantity: number;
  note: string | null;
  created_at: string;
}

export const MAX_LOCATIONS = 50;

/** The workspace's default location id, created on first use (worker role). */
export async function ensureDefaultLocationTx(tx: TenantTransaction, accountId: string): Promise<string> {
  const find = () => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM stock_locations WHERE account_id=${accountId}::uuid AND is_default`;
  let [row] = await find();
  if (row) return row.id;
  const name = getT('Commerce.locations')('defaultName').slice(0, 80);
  await tx.$executeRaw`INSERT INTO stock_locations(account_id,name,is_default) VALUES(${accountId}::uuid,${name},true) ON CONFLICT DO NOTHING`;
  [row] = await find();
  // A name clash with a location made before the default existed cannot happen: every writer calls this first.
  if (!row) throw new CatalogueError('conflict');
  return row.id;
}

async function locationRows(tx: TenantTransaction, accountId: string): Promise<StockLocation[]> {
  const rows = await tx.$queryRaw<(Omit<StockLocation, 'units'> & { placed: bigint; on_hand: bigint })[]>`
    SELECT s.id::text AS id, s.name, s.is_default, s.active, s.position,
      COALESCE((SELECT sum(l.quantity) FROM stock_location_levels l WHERE l.account_id=s.account_id AND l.location_id=s.id),0)::bigint AS placed,
      COALESCE((SELECT sum(i.on_hand) FROM inventory_levels i WHERE i.account_id=s.account_id),0)::bigint AS on_hand
    FROM stock_locations s WHERE s.account_id=${accountId}::uuid
    ORDER BY s.is_default DESC, s.position, s.created_at, s.id LIMIT 200`;
  const elsewhere = rows.filter((r) => !r.is_default).reduce((sum, r) => sum + Number(r.placed), 0);
  return rows.map(({ placed, on_hand, ...r }) => ({ ...r, units: r.is_default ? Number(on_hand) - elsewhere : Number(placed) }));
}

/** Every location with the units it holds (agents and above; makes the default location on first use). */
export function listLocations(ctx: TenantContext): Promise<StockLocation[]> {
  return withTenant(ctx, async (tx) => {
    await ensureDefaultLocationTx(tx, ctx.accountId);
    return locationRows(tx, ctx.accountId);
  }, getWorkerPrisma());
}

/** One variant's quantity at every location; the default location holds the rest of on hand. */
export async function variantLocationsTx(tx: TenantTransaction, accountId: string, variantId: string): Promise<LocationQuantity[]> {
  if (!isId(variantId)) throw new CatalogueError('not_found');
  const rows = await tx.$queryRaw<(Omit<LocationQuantity, 'quantity'> & { quantity: number | null; on_hand: number | null })[]>`
    SELECT s.id::text AS location_id, s.name, s.is_default, s.active, l.quantity,
      (SELECT i.on_hand FROM inventory_levels i WHERE i.account_id=s.account_id AND i.variant_id=${variantId}::uuid) AS on_hand
    FROM stock_locations s
    LEFT JOIN stock_location_levels l ON l.account_id=s.account_id AND l.location_id=s.id AND l.variant_id=${variantId}::uuid
    WHERE s.account_id=${accountId}::uuid ORDER BY s.is_default DESC, s.position, s.created_at, s.id LIMIT 200`;
  const elsewhere = rows.filter((r) => !r.is_default).map((r) => r.quantity ?? 0);
  return rows.map(({ on_hand, quantity, ...r }) => ({ ...r, quantity: r.is_default ? defaultLocationQuantity(on_hand ?? 0, elsewhere) : quantity ?? 0 }));
}

export function variantLocations(ctx: TenantContext, variantId: string): Promise<LocationQuantity[]> {
  return withTenant(ctx, async (tx) => {
    await ensureDefaultLocationTx(tx, ctx.accountId);
    return variantLocationsTx(tx, ctx.accountId, variantId);
  }, getWorkerPrisma());
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string') throw new CatalogueError('invalid', 'name');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!name || name.length > 80) throw new CatalogueError('invalid', 'name');
  return name;
}

const isUnique = (error: unknown): boolean => {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  return e?.meta?.code === '23505' || e?.code === '23505' || e?.code === 'P2002' || /23505|unique constraint/i.test(e?.message ?? '');
};

/** Body { name }. Admins with commerce.inventory. */
export async function createLocation(ctx: TenantContext & { userId: string }, raw: unknown): Promise<StockLocation> {
  await requirePermission(ctx, 'commerce.inventory');
  const name = parseName(asBody(raw).name);
  try {
    return await withTenant(ctx, async (tx) => {
      await ensureDefaultLocationTx(tx, ctx.accountId);
      const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM stock_locations WHERE account_id=${ctx.accountId}::uuid`;
      if (count.n >= MAX_LOCATIONS) throw new CatalogueError('invalid', 'name', 'too_many');
      const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO stock_locations(account_id,name,position,created_by)
        VALUES(${ctx.accountId}::uuid,${name},${count.n},${ctx.userId}::uuid) RETURNING id::text AS id`;
      await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.stock_location_created', row.id);
      return (await locationRows(tx, ctx.accountId)).find((l) => l.id === row.id)!;
    }, getWorkerPrisma());
  } catch (error) {
    if (isUnique(error)) throw new CatalogueError('name_taken', 'name');
    throw error;
  }
}

/** Body { name?, active? }. The default location cannot be turned off, nor one that still holds stock. */
export async function updateLocation(ctx: TenantContext & { userId: string }, id: string, raw: unknown): Promise<StockLocation> {
  await requirePermission(ctx, 'commerce.inventory');
  if (!isId(id)) throw new CatalogueError('not_found');
  const b = asBody(raw);
  const name = has(b, 'name') ? parseName(b.name) : null;
  if (has(b, 'active') && typeof b.active !== 'boolean') throw new CatalogueError('invalid', 'active');
  const active = has(b, 'active') ? (b.active as boolean) : null;
  try {
    return await withTenant(ctx, async (tx) => {
      const [row] = await tx.$queryRaw<{ is_default: boolean; active: boolean }[]>`
        SELECT is_default, active FROM stock_locations WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
      if (!row) throw new CatalogueError('not_found');
      if (active === false && row.active) {
        if (row.is_default) throw new CatalogueError('location_in_use');
        const [held] = await tx.$queryRaw<{ n: bigint }[]>`SELECT COALESCE(sum(quantity),0)::bigint AS n FROM stock_location_levels
          WHERE account_id=${ctx.accountId}::uuid AND location_id=${id}::uuid`;
        if (Number(held.n) > 0) throw new CatalogueError('location_in_use');
      }
      await tx.$executeRaw`UPDATE stock_locations SET name=COALESCE(${name}, name), active=COALESCE(${active}::boolean, active)
        WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
      await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.stock_location_updated', id, { renamed: name !== null, active });
      return (await locationRows(tx, ctx.accountId)).find((l) => l.id === id)!;
    }, getWorkerPrisma());
  } catch (error) {
    if (isUnique(error)) throw new CatalogueError('name_taken', 'name');
    throw error;
  }
}

/** An active location of this workspace, locked against being turned off meanwhile; refuses otherwise. */
export async function activeLocationTx(tx: TenantTransaction, accountId: string, id: string): Promise<{ id: string; is_default: boolean }> {
  const [row] = await tx.$queryRaw<{ id: string; is_default: boolean; active: boolean }[]>`
    SELECT id::text AS id, is_default, active FROM stock_locations WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR SHARE`;
  if (!row) throw new CatalogueError('not_found', 'location_id');
  if (!row.active) throw new CatalogueError('location_inactive', 'location_id');
  return row;
}

/**
 * Count units that were just added to on hand (a receipt) at a location. The default location needs
 * nothing: it already holds whatever is not counted elsewhere. The caller holds the level row lock
 * (stock.adjustTx updated it in this transaction).
 */
export async function addToLocationTx(tx: TenantTransaction, accountId: string, locationId: string, variantId: string, quantity: number): Promise<void> {
  const location = await activeLocationTx(tx, accountId, locationId);
  if (location.is_default) return;
  await tx.$executeRaw`INSERT INTO stock_location_levels(account_id,location_id,variant_id,quantity)
    VALUES(${accountId}::uuid,${locationId}::uuid,${variantId}::uuid,${quantity})
    ON CONFLICT (account_id,variant_id,location_id) DO UPDATE SET quantity = stock_location_levels.quantity + EXCLUDED.quantity`;
}

export interface TransferInput {
  clientKey: string;
  fromLocationId: string;
  toLocationId: string;
  variantId: string;
  quantity: number;
  note: string | null;
}

/** Body { client_key, from_location_id, to_location_id, variant_id, quantity, note? }. */
export function parseTransferInput(raw: unknown): TransferInput {
  const b = asBody(raw);
  const request = { clientKey: b.client_key, fromLocationId: b.from_location_id, toLocationId: b.to_location_id, variantId: b.variant_id, quantity: b.quantity };
  const problem = transferProblem(request);
  if (problem) throw new CatalogueError('invalid', problem);
  let note: string | null = null;
  if (has(b, 'note') && b.note !== null && b.note !== '') {
    if (typeof b.note !== 'string' || b.note.trim().length > 200) throw new CatalogueError('invalid', 'note');
    note = b.note.trim() || null;
  }
  return { ...(request as Omit<TransferInput, 'note'>), note };
}

/**
 * Move units of one variant between two locations in the caller's worker transaction. All or nothing:
 * the variant's level row is locked first, so concurrent transfers and sales of the variant queue up
 * and a location can never go below zero. A repeated client key changes nothing (replayed: true); the
 * same key with different details is refused (key_reused).
 */
export async function transferStockTx(tx: TenantTransaction, accountId: string, input: TransferInput & { actorUserId: string | null }):
  Promise<{ transferId: string; replayed: boolean }> {
  const problem = transferProblem(input);
  if (problem) throw new CatalogueError('invalid', problem);
  const same = async (): Promise<{ transferId: string; replayed: boolean } | null> => {
    const [prior] = await tx.$queryRaw<{ id: string; from_location_id: string; to_location_id: string; variant_id: string; quantity: number }[]>`
      SELECT id::text AS id, from_location_id::text AS from_location_id, to_location_id::text AS to_location_id,
        variant_id::text AS variant_id, quantity FROM stock_transfers
      WHERE account_id=${accountId}::uuid AND client_key=${input.clientKey}`;
    if (!prior) return null;
    if (prior.from_location_id !== input.fromLocationId.toLowerCase() || prior.to_location_id !== input.toLocationId.toLowerCase()
      || prior.variant_id !== input.variantId.toLowerCase() || prior.quantity !== input.quantity) throw new CatalogueError('key_reused', 'client_key');
    return { transferId: prior.id, replayed: true };
  };
  const replay = await same();
  if (replay) return replay;

  const from = await activeLocationTx(tx, accountId, input.fromLocationId);
  const to = await activeLocationTx(tx, accountId, input.toLocationId);
  const [level] = await tx.$queryRaw<{ on_hand: number }[]>`SELECT on_hand FROM inventory_levels
    WHERE account_id=${accountId}::uuid AND variant_id=${input.variantId}::uuid FOR UPDATE`;
  if (!level) {
    const [variant] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_variants
      WHERE account_id=${accountId}::uuid AND id=${input.variantId}::uuid`;
    throw new CatalogueError(variant ? 'insufficient_stock' : 'not_found', 'variant_id');
  }
  // The key is claimed after the level lock: a concurrent request with the same key waits here and then replays.
  const [made] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO stock_transfers(account_id,client_key,from_location_id,to_location_id,variant_id,quantity,note,created_by)
    VALUES(${accountId}::uuid,${input.clientKey},${input.fromLocationId}::uuid,${input.toLocationId}::uuid,${input.variantId}::uuid,
      ${input.quantity},${input.note},${input.actorUserId}::uuid)
    ON CONFLICT (account_id,client_key) DO NOTHING RETURNING id::text AS id`;
  if (!made) {
    const raced = await same();
    if (raced) return raced;
    throw new CatalogueError('conflict');
  }
  const rows = await tx.$queryRaw<{ location_id: string; quantity: number }[]>`SELECT location_id::text AS location_id, quantity
    FROM stock_location_levels WHERE account_id=${accountId}::uuid AND variant_id=${input.variantId}::uuid ORDER BY location_id FOR UPDATE`;
  const available = from.is_default ? defaultLocationQuantity(level.on_hand, rows.map((r) => r.quantity))
    : rows.find((r) => r.location_id === from.id)?.quantity ?? 0;
  // Throwing rolls the whole transaction back, the claimed key included.
  if (available < input.quantity) throw new CatalogueError('insufficient_stock', 'quantity');
  if (!from.is_default) {
    const moved = await tx.$executeRaw`UPDATE stock_location_levels SET quantity = quantity - ${input.quantity}
      WHERE account_id=${accountId}::uuid AND variant_id=${input.variantId}::uuid AND location_id=${from.id}::uuid AND quantity >= ${input.quantity}`;
    if (moved !== 1) throw new CatalogueError('insufficient_stock', 'quantity');
  }
  if (!to.is_default)
    await tx.$executeRaw`INSERT INTO stock_location_levels(account_id,location_id,variant_id,quantity)
      VALUES(${accountId}::uuid,${to.id}::uuid,${input.variantId}::uuid,${input.quantity})
      ON CONFLICT (account_id,variant_id,location_id) DO UPDATE SET quantity = stock_location_levels.quantity + EXCLUDED.quantity`;
  await auditCatalogue(tx, accountId, input.actorUserId, 'commerce.stock_transferred', made.id,
    { variant_id: input.variantId, from: from.id, to: to.id, quantity: input.quantity });
  return { transferId: made.id, replayed: false };
}

/** Staff transfer: admins with commerce.inventory, on the worker role, audited. */
export async function transferStock(ctx: TenantContext & { userId: string }, input: TransferInput): Promise<{ transferId: string; replayed: boolean }> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    await ensureDefaultLocationTx(tx, ctx.accountId);
    return transferStockTx(tx, ctx.accountId, { ...input, actorUserId: ctx.userId });
  }, getWorkerPrisma());
}

/** The latest transfers, newest first (agents and above; app role). */
export async function listTransfers(tx: TenantTransaction, accountId: string): Promise<StockTransfer[]> {
  const rows = await tx.$queryRaw<(Omit<StockTransfer, 'created_at'> & { created_at: Date })[]>`
    SELECT t.id::text AS id, t.from_location_id::text AS from_location_id, t.to_location_id::text AS to_location_id,
      t.variant_id::text AS variant_id, v.sku, p.name AS product_name, t.quantity, t.note, t.created_at
    FROM stock_transfers t
    JOIN shop_variants v ON v.account_id=t.account_id AND v.id=t.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    WHERE t.account_id=${accountId}::uuid ORDER BY t.created_at DESC, t.id DESC LIMIT 50`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}
