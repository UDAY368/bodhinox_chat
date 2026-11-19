/**
 * Purchase orders that receive into stock (store plan Phase 8).
 *
 * draft -> ordered -> partially_received -> received -> closed, or cancelled (stock-rules.ts).
 * Reads run on the app role (agents and above; RLS). Every write runs on the worker role after the
 * member's role and the commerce.inventory permission were checked, like every other stock write.
 *
 * Receiving goes through stock.adjustTx ('receipt'), so it writes the stock ledger, clears a low-stock
 * flag and wakes back-in-stock alerts exactly like a manual stock edit; the units are then counted at
 * the chosen location (stock-locations.ts). One receive request is one purchase_order_receipts row:
 * its request key makes a retry a no-op. Lock order: the purchase order row, then inventory rows in
 * ascending variant id.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { asBody, auditCatalogue, CatalogueError, has, isId } from './catalogue/products';
import { MAX_MINOR, minorFromDb } from './money';
import { adjustTx, StockError } from './stock';
import { activeLocationTx, addToLocationTx, ensureDefaultLocationTx } from './stock-locations';
import {
  isPoAction, MAX_STOCK_UNITS, poEditable, poStatusAfterReceipt, poTransition, receiptProblem, REQUEST_KEY,
  type PoAction, type PoReceiveLine, type PoStatus,
} from './stock-rules';
import { lockStoreCurrencyShared } from './store-settings';

export const PO_MAX_LINES = 100;

export interface PurchaseOrderLine {
  id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost_minor: number;
}

export interface PurchaseOrderSummary {
  id: string;
  supplier_name: string;
  reference: string | null;
  currency: string;
  status: PoStatus;
  line_count: number;
  units_ordered: number;
  units_received: number;
  total_cost_minor: number;
  created_at: string;
}

export interface PurchaseOrder extends Omit<PurchaseOrderSummary, 'line_count'> {
  note: string | null;
  ordered_at: string | null;
  closed_at: string | null;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrderInput {
  supplierName: string;
  reference: string | null;
  note: string | null;
  lines: Array<{ variantId: string; qtyOrdered: number; unitCostMinor: number }>;
}

const clean = (value: unknown, max: number, field: string, required: boolean): string | null => {
  if (value === null || value === undefined || value === '') {
    if (required) throw new CatalogueError('invalid', field);
    return null;
  }
  if (typeof value !== 'string') throw new CatalogueError('invalid', field);
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if ((required && !v) || v.length > max) throw new CatalogueError('invalid', field);
  return v || null;
};

/** Body { supplier_name, reference?, note?, lines: [{ variant_id, qty_ordered, unit_cost_minor }] } (a full replacement). */
export function parsePurchaseOrderInput(raw: unknown): PurchaseOrderInput {
  const b = asBody(raw);
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > PO_MAX_LINES) throw new CatalogueError('invalid', 'lines');
  const seen = new Set<string>();
  const lines = b.lines.map((entry) => {
    const l = asBody(entry);
    const cost = l.unit_cost_minor ?? 0;
    if (!isId(l.variant_id) || seen.has(l.variant_id.toLowerCase())) throw new CatalogueError('invalid', 'variant_id');
    seen.add(l.variant_id.toLowerCase());
    if (typeof l.qty_ordered !== 'number' || !Number.isInteger(l.qty_ordered) || l.qty_ordered < 1 || l.qty_ordered > MAX_STOCK_UNITS)
      throw new CatalogueError('invalid', 'qty_ordered');
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 0 || cost > MAX_MINOR) throw new CatalogueError('invalid', 'unit_cost_minor');
    return { variantId: l.variant_id.toLowerCase(), qtyOrdered: l.qty_ordered, unitCostMinor: cost };
  });
  return {
    supplierName: clean(b.supplier_name, 120, 'supplier_name', true)!, reference: clean(b.reference, 60, 'reference', false),
    note: clean(b.note, 500, 'note', false), lines,
  };
}

interface PoRow {
  id: string; supplier_name: string; reference: string | null; note: string | null; currency: string; status: PoStatus;
  ordered_at: Date | null; closed_at: Date | null; created_at: Date;
}
interface LineRow { id: string; variant_id: string; sku: string; product_name: string; qty_ordered: number; qty_received: number; unit_cost_minor: bigint }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function loadLines(tx: TenantTransaction, accountId: string, id: string, lock = false): Promise<PurchaseOrderLine[]> {
  const rows = lock
    ? await tx.$queryRaw<LineRow[]>`SELECT l.id::text AS id, l.variant_id::text AS variant_id, v.sku, p.name AS product_name, l.qty_ordered, l.qty_received, l.unit_cost_minor
        FROM purchase_order_lines l
        JOIN shop_variants v ON v.account_id=l.account_id AND v.id=l.variant_id
        JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
        WHERE l.account_id=${accountId}::uuid AND l.purchase_order_id=${id}::uuid ORDER BY l.variant_id FOR UPDATE OF l`
    : await tx.$queryRaw<LineRow[]>`SELECT l.id::text AS id, l.variant_id::text AS variant_id, v.sku, p.name AS product_name, l.qty_ordered, l.qty_received, l.unit_cost_minor
        FROM purchase_order_lines l
        JOIN shop_variants v ON v.account_id=l.account_id AND v.id=l.variant_id
        JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
        WHERE l.account_id=${accountId}::uuid AND l.purchase_order_id=${id}::uuid ORDER BY l.variant_id`;
  return rows.map((r) => ({ ...r, unit_cost_minor: minorFromDb(r.unit_cost_minor) ?? 0 }));
}

const totals = (lines: PurchaseOrderLine[]) => ({
  units_ordered: lines.reduce((s, l) => s + l.qty_ordered, 0),
  units_received: lines.reduce((s, l) => s + l.qty_received, 0),
  // Whole minor units times whole counts; BigInt keeps a very large order exact.
  total_cost_minor: Number(lines.reduce((s, l) => s + BigInt(l.unit_cost_minor) * BigInt(l.qty_ordered), BigInt(0))),
});

/** One purchase order with its lines (agents and above). */
export async function getPurchaseOrder(tx: TenantTransaction, accountId: string, id: string): Promise<PurchaseOrder> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const [row] = await tx.$queryRaw<PoRow[]>`SELECT id::text AS id, supplier_name, reference, note, currency, status, ordered_at, closed_at, created_at
    FROM purchase_orders WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  if (!row) throw new CatalogueError('not_found');
  const lines = await loadLines(tx, accountId, id);
  return { ...row, ordered_at: iso(row.ordered_at), closed_at: iso(row.closed_at), created_at: row.created_at.toISOString(), lines, ...totals(lines) };
}

/** The latest purchase orders, newest first (agents and above). */
export async function listPurchaseOrders(tx: TenantTransaction, accountId: string): Promise<PurchaseOrderSummary[]> {
  const rows = await tx.$queryRaw<(Pick<PoRow, 'id' | 'supplier_name' | 'reference' | 'currency' | 'status' | 'created_at'>
    & { line_count: number; units_ordered: bigint; units_received: bigint; total_cost_minor: string })[]>`
    SELECT o.id::text AS id, o.supplier_name, o.reference, o.currency, o.status, o.created_at,
      count(l.id)::int AS line_count, COALESCE(sum(l.qty_ordered),0)::bigint AS units_ordered,
      COALESCE(sum(l.qty_received),0)::bigint AS units_received,
      COALESCE(sum(l.unit_cost_minor * l.qty_ordered),0)::text AS total_cost_minor
    FROM purchase_orders o
    LEFT JOIN purchase_order_lines l ON l.account_id=o.account_id AND l.purchase_order_id=o.id
    WHERE o.account_id=${accountId}::uuid GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC LIMIT 100`;
  return rows.map((r) => ({ ...r, units_ordered: Number(r.units_ordered), units_received: Number(r.units_received),
    total_cost_minor: Number(r.total_cost_minor), created_at: r.created_at.toISOString() }));
}

/** Every line's variant must be a tracked, live variant of this workspace. */
async function assertTracked(tx: TenantTransaction, accountId: string, variantIds: string[]): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_variants
    WHERE account_id=${accountId}::uuid AND id = ANY(${variantIds}::uuid[]) AND track_inventory AND archived_at IS NULL`;
  if (rows.length !== variantIds.length) throw new CatalogueError('not_tracked', 'variant_id');
}

async function insertLines(tx: TenantTransaction, accountId: string, id: string, lines: PurchaseOrderInput['lines']): Promise<void> {
  for (const line of lines)
    await tx.$executeRaw`INSERT INTO purchase_order_lines(account_id,purchase_order_id,variant_id,qty_ordered,unit_cost_minor)
      VALUES(${accountId}::uuid,${id}::uuid,${line.variantId}::uuid,${line.qtyOrdered},${line.unitCostMinor})`;
}

/** Create a draft purchase order in the store currency. Admins with commerce.inventory. */
export async function createPurchaseOrder(ctx: TenantContext & { userId: string }, input: PurchaseOrderInput): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    const [settings] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
    if (!settings?.currency) throw new CatalogueError('store_not_configured');
    // Costs are amounts in the store currency: hold it against a concurrent currency change.
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertTracked(tx, ctx.accountId, input.lines.map((l) => l.variantId));
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO purchase_orders(account_id,supplier_name,reference,note,currency,created_by)
      VALUES(${ctx.accountId}::uuid,${input.supplierName},${input.reference},${input.note},${settings.currency},${ctx.userId}::uuid)
      RETURNING id::text AS id`;
    await insertLines(tx, ctx.accountId, row.id, input.lines);
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.purchase_order_created', row.id, { lines: input.lines.length });
    return getPurchaseOrder(tx, ctx.accountId, row.id);
  }, getWorkerPrisma());
}

async function lockPo(tx: TenantTransaction, accountId: string, id: string): Promise<{ status: PoStatus; reference: string | null }> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const [row] = await tx.$queryRaw<{ status: PoStatus; reference: string | null }[]>`SELECT status, reference FROM purchase_orders
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid FOR UPDATE`;
  if (!row) throw new CatalogueError('not_found');
  return row;
}

/** Replace a draft's details and lines; refused (po_state) once it was ordered. */
export async function updatePurchaseOrder(ctx: TenantContext & { userId: string }, id: string, input: PurchaseOrderInput): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    const po = await lockPo(tx, ctx.accountId, id);
    if (!poEditable(po.status)) throw new CatalogueError('po_state');
    await lockStoreCurrencyShared(tx, ctx.accountId);
    await assertTracked(tx, ctx.accountId, input.lines.map((l) => l.variantId));
    await tx.$executeRaw`UPDATE purchase_orders SET supplier_name=${input.supplierName}, reference=${input.reference}, note=${input.note}
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    await tx.$executeRaw`DELETE FROM purchase_order_lines WHERE account_id=${ctx.accountId}::uuid AND purchase_order_id=${id}::uuid`;
    await insertLines(tx, ctx.accountId, id, input.lines);
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.purchase_order_updated', id, { lines: input.lines.length });
    return getPurchaseOrder(tx, ctx.accountId, id);
  }, getWorkerPrisma());
}

/** Body { action: 'order' | 'cancel' | 'close' }. */
export function parsePoAction(raw: unknown): PoAction {
  const action = asBody(raw).action;
  if (!isPoAction(action)) throw new CatalogueError('invalid', 'action');
  return action;
}

/** Place, cancel or close a purchase order; a step the state machine does not allow is refused (po_state). */
export async function changePurchaseOrderStatus(ctx: TenantContext & { userId: string }, id: string, action: PoAction): Promise<PurchaseOrder> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    const po = await lockPo(tx, ctx.accountId, id);
    const next = poTransition(po.status, action);
    if (!next) throw new CatalogueError('po_state');
    await tx.$executeRaw`UPDATE purchase_orders SET status=${next},
        ordered_at=CASE WHEN ${next}='ordered' THEN now() ELSE ordered_at END,
        closed_at=CASE WHEN ${next} IN ('closed','cancelled') THEN now() ELSE closed_at END
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.purchase_order_status', id, { from: po.status, to: next });
    return getPurchaseOrder(tx, ctx.accountId, id);
  }, getWorkerPrisma());
}

export interface ReceiveInput {
  requestKey: string;
  /** null = the default location. */
  locationId: string | null;
  lines: PoReceiveLine[];
}

/** Body { request_key, location_id?, lines: [{ line_id, quantity }] }. */
export function parseReceiveInput(raw: unknown): ReceiveInput {
  const b = asBody(raw);
  if (typeof b.request_key !== 'string' || !REQUEST_KEY.test(b.request_key)) throw new CatalogueError('invalid', 'request_key');
  const locationId = has(b, 'location_id') && b.location_id !== null ? b.location_id : null;
  if (locationId !== null && !isId(locationId)) throw new CatalogueError('invalid', 'location_id');
  if (!Array.isArray(b.lines) || b.lines.length < 1 || b.lines.length > PO_MAX_LINES) throw new CatalogueError('invalid', 'lines');
  const lines = b.lines.map((entry) => {
    const l = asBody(entry);
    if (!isId(l.line_id)) throw new CatalogueError('invalid', 'line_id');
    if (typeof l.quantity !== 'number' || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_STOCK_UNITS)
      throw new CatalogueError('invalid', 'quantity');
    return { lineId: l.line_id.toLowerCase(), quantity: l.quantity };
  });
  return { requestKey: b.request_key, locationId, lines };
}

/**
 * Receive units of a placed purchase order into stock at a location. All or nothing in one worker
 * transaction: never more than was ordered (over_receive), and a repeated request key changes nothing
 * (replayed: true). Each line is a 'receipt' movement in the stock ledger and wakes back-in-stock
 * alerts through stock.adjustTx, like a manual stock edit.
 */
export async function receivePurchaseOrder(ctx: TenantContext & { userId: string }, id: string, input: ReceiveInput):
  Promise<{ order: PurchaseOrder; replayed: boolean }> {
  await requirePermission(ctx, 'commerce.inventory');
  return withTenant(ctx, async (tx) => {
    const po = await lockPo(tx, ctx.accountId, id);
    // Under the order's row lock: a concurrent request with this key has either committed (seen here) or waits behind us.
    const [prior] = await tx.$queryRaw<{ purchase_order_id: string }[]>`SELECT purchase_order_id::text AS purchase_order_id
      FROM purchase_order_receipts WHERE account_id=${ctx.accountId}::uuid AND request_key=${input.requestKey}`;
    if (prior) {
      if (prior.purchase_order_id !== id.toLowerCase()) throw new CatalogueError('key_reused', 'request_key');
      return { order: await getPurchaseOrder(tx, ctx.accountId, id), replayed: true };
    }
    const lines = await loadLines(tx, ctx.accountId, id, true);
    const problem = receiptProblem(po.status, lines.map((l) => ({ id: l.id, qtyOrdered: l.qty_ordered, qtyReceived: l.qty_received })), input.lines);
    if (problem) throw new CatalogueError(problem, problem === 'invalid' ? 'lines' : undefined);
    const locationId = input.locationId ?? await ensureDefaultLocationTx(tx, ctx.accountId);
    // Before anything is written: an unknown, foreign or switched-off location is a clean refusal.
    await activeLocationTx(tx, ctx.accountId, locationId);
    const byId = new Map(lines.map((l) => [l.id, l]));
    // Ascending variant id: the stock lock order.
    const receiving = input.lines.map((r) => ({ ...r, line: byId.get(r.lineId)! })).sort((a, b) => (a.line.variant_id < b.line.variant_id ? -1 : 1));
    await assertTracked(tx, ctx.accountId, receiving.map((r) => r.line.variant_id));
    const [receipt] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO purchase_order_receipts(account_id,purchase_order_id,request_key,location_id,lines,received_by)
      VALUES(${ctx.accountId}::uuid,${id}::uuid,${input.requestKey},${locationId}::uuid,
        ${JSON.stringify(receiving.map((r) => ({ line_id: r.lineId, variant_id: r.line.variant_id, quantity: r.quantity })))}::jsonb,${ctx.userId}::uuid)
      ON CONFLICT (account_id,request_key) DO NOTHING RETURNING id::text AS id`;
    if (!receipt) throw new CatalogueError('key_reused', 'request_key');
    const reason = `PO ${po.reference ?? id.slice(0, 8).toUpperCase()}`.slice(0, 200);
    for (const r of receiving) {
      try {
        await adjustTx(tx, ctx.accountId, { variantId: r.line.variant_id, delta: r.quantity, kind: 'receipt', reason, actorUserId: ctx.userId });
      } catch (error) {
        if (error instanceof StockError) throw new CatalogueError(error.code === 'not_found' ? 'not_found' : 'invalid', 'quantity');
        throw error;
      }
      await addToLocationTx(tx, ctx.accountId, locationId, r.line.variant_id, r.quantity);
      const counted = await tx.$executeRaw`UPDATE purchase_order_lines SET qty_received = qty_received + ${r.quantity}
        WHERE account_id=${ctx.accountId}::uuid AND id=${r.lineId}::uuid AND qty_received + ${r.quantity} <= qty_ordered`;
      if (counted !== 1) throw new CatalogueError('over_receive');
    }
    const after = lines.map((l) => ({ qtyOrdered: l.qty_ordered, qtyReceived: l.qty_received + (receiving.find((r) => r.lineId === l.id)?.quantity ?? 0) }));
    const status = poStatusAfterReceipt(after);
    await tx.$executeRaw`UPDATE purchase_orders SET status=${status} WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    await auditCatalogue(tx, ctx.accountId, ctx.userId, 'commerce.purchase_order_received', id,
      { receipt: receipt.id, location: locationId, lines: receiving.length, units: receiving.reduce((s, r) => s + r.quantity, 0), status });
    return { order: await getPurchaseOrder(tx, ctx.accountId, id), replayed: false };
  }, getWorkerPrisma());
}
