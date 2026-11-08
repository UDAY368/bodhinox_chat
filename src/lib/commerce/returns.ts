/**
 * Staff-created returns (design §3, T5; customer self-service is deferred).
 *
 *   requested -> received -> inspected -> closed
 *   requested | received -> rejected
 *
 * Inspection records a disposition per returned line (restock | discard).
 * Stock comes back only two ways, never both:
 *   - a refund linked to the return (refundReturn) restocks the 'restock'
 *     lines when Razorpay reports it processed (lib/payments/refunds, which
 *     also stamps restocked_at);
 *   - an admin closing the return without a refund may restock explicitly.
 * Every change runs in a worker transaction as the signed-in member, is
 * audited and adds an order_events row; ids and codes only.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { requestRefund } from '@/lib/payments/refunds';
import { minorFromDb } from './money';
import { asStaff, auditOrder, lockOrder, type StaffContext } from './order-lifecycle';
import { OrderError } from './orders';
import { restockTx } from './stock';

export const RETURN_STATUSES = ['requested', 'received', 'inspected', 'closed', 'rejected'] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export type Disposition = 'restock' | 'discard';

/** Orders a return can be opened for: the goods have left the store. */
const RETURNABLE: ReadonlySet<string> = new Set(['dispatched', 'fulfilled']);
const NOTE_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReturnLine { order_item_id: string; qty: number }

export interface OrderReturn {
  id: string;
  order_id: string;
  status: ReturnStatus;
  items: ReturnLine[];
  disposition: Record<string, Disposition> | null;
  refund_id: string | null;
  note: string | null;
  restocked_at: string | null;
  created_at: string;
  updated_at: string;
}

function assertStaff(ctx: StaffContext): void {
  if (!ctx.role || !hasMinRole(ctx.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
}

function cleanNote(note: unknown): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string') throw new OrderError(400, 'invalid', 'Invalid note');
  const text = note.trim();
  if (text.length > NOTE_MAX) throw new OrderError(400, 'invalid', 'Note is too long');
  return text || null;
}

/** Validate the requested lines (ids unique, quantities 1-100000). */
export function parseReturnLines(value: unknown): ReturnLine[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new OrderError(400, 'invalid', 'Choose the items being returned');
  const seen = new Set<string>();
  return value.map((entry) => {
    const e = entry as Record<string, unknown> | null;
    const id = e?.order_item_id, qty = e?.qty;
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) throw new OrderError(400, 'invalid', 'Invalid item');
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > 100_000) throw new OrderError(400, 'invalid', 'Invalid quantity');
    seen.add(id);
    return { order_item_id: id, qty };
  });
}

/** Validate a disposition: exactly one restock|discard per returned line. */
export function parseDisposition(value: unknown, lines: ReturnLine[]): Record<string, Disposition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrderError(400, 'invalid', 'Invalid disposition');
  const input = value as Record<string, unknown>;
  const ids = lines.map((l) => l.order_item_id);
  if (Object.keys(input).length !== ids.length || ids.some((id) => input[id] !== 'restock' && input[id] !== 'discard'))
    throw new OrderError(400, 'invalid', 'Choose restock or discard for every item');
  return Object.fromEntries(ids.map((id) => [id, input[id] as Disposition]));
}

interface ReturnDbRow {
  id: string; order_id: string; status: ReturnStatus; items: unknown; disposition: unknown; refund_id: string | null;
  note: string | null; restocked_at: Date | null; created_at: Date; updated_at: Date;
}

const RETURN_COLUMNS = `id::text AS id, order_id::text AS order_id, status, items, disposition, refund_id::text AS refund_id,
  note, restocked_at, created_at, updated_at`;

function toReturn(row: ReturnDbRow): OrderReturn {
  return {
    id: row.id, order_id: row.order_id, status: row.status,
    items: Array.isArray(row.items) ? (row.items as ReturnLine[]) : [],
    disposition: row.disposition && typeof row.disposition === 'object' ? (row.disposition as Record<string, Disposition>) : null,
    refund_id: row.refund_id, note: row.note, restocked_at: row.restocked_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

async function lockReturn(tx: TenantTransaction, accountId: string, returnId: string): Promise<OrderReturn> {
  if (!UUID.test(returnId)) throw new OrderError(404, 'not_found', 'Return not found');
  const [row] = await tx.$queryRawUnsafe<ReturnDbRow[]>(
    `SELECT ${RETURN_COLUMNS} FROM order_returns WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE`, accountId, returnId);
  if (!row) throw new OrderError(404, 'not_found', 'Return not found');
  return toReturn(row);
}

/** A Postgres unique violation (23505), raw or as Prisma wraps it from $queryRaw. */
export function isUniqueViolation(error: unknown): boolean {
  const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } } | null;
  if (!failure || typeof failure !== 'object') return false;
  return failure.code === '23505' || failure.code === 'P2002' || failure.meta?.code === '23505'
    || failure.meta?.driverAdapterError?.cause?.originalCode === '23505';
}

async function event(tx: TenantTransaction, ctx: StaffContext, orderId: string, kind: string) {
  await tx.$executeRaw`INSERT INTO order_events(account_id, order_id, kind, actor, actor_user_id)
    VALUES(${ctx.accountId}::uuid, ${orderId}::uuid, ${kind}, 'staff', ${ctx.userId}::uuid)`;
}

/**
 * Open a return on a dispatched or delivered order. A line's quantity may
 * not exceed what was ordered minus what other non-rejected returns already
 * cover (checked under the order lock, so two agents cannot both return it).
 */
export async function createReturn(ctx: StaffContext, orderId: string, input: { items: unknown; note?: unknown }): Promise<OrderReturn> {
  assertStaff(ctx);
  const lines = parseReturnLines(input.items);
  const note = cleanNote(input.note);
  return asStaff(ctx, async (tx) => {
    const order = await lockOrder(tx, ctx.accountId, orderId);
    if (!RETURNABLE.has(order.status)) throw new OrderError(409, 'bad_transition', 'Only a dispatched or delivered order can be returned');
    // Its stock is still only held: a refused COD parcel is cancelled (releasing the hold once), never restocked as a return.
    if (order.unpaidCod) throw new OrderError(409, 'bad_transition', 'An unpaid cash-on-delivery order that comes back is cancelled, not returned');
    const ordered = await tx.$queryRaw<{ id: string; quantity: number }[]>`SELECT id::text AS id, quantity FROM order_items
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid`;
    const taken = await tx.$queryRaw<{ id: string; qty: number }[]>`
      SELECT x->>'order_item_id' AS id, sum((x->>'qty')::int)::int AS qty
      FROM order_returns r, jsonb_array_elements(r.items) x
      WHERE r.account_id=${ctx.accountId}::uuid AND r.order_id=${orderId}::uuid AND r.status <> 'rejected'
      GROUP BY 1`;
    const orderedOf = new Map(ordered.map((i) => [i.id, i.quantity]));
    const takenOf = new Map(taken.map((i) => [i.id, i.qty]));
    for (const line of lines) {
      const max = orderedOf.get(line.order_item_id);
      if (max === undefined) throw new OrderError(400, 'invalid', 'Item is not on this order');
      if (line.qty + (takenOf.get(line.order_item_id) ?? 0) > max) throw new OrderError(409, 'conflict', 'More units than were ordered');
    }
    const [row] = await tx.$queryRawUnsafe<ReturnDbRow[]>(
      `INSERT INTO order_returns(account_id, order_id, items, note, created_by) VALUES($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid)
       RETURNING ${RETURN_COLUMNS}`, ctx.accountId, orderId, JSON.stringify(lines), note, ctx.userId);
    await event(tx, ctx, orderId, 'return_requested');
    await auditOrder(tx, ctx, 'order.return_created', row.id, { order_id: orderId, lines: lines.length });
    return toReturn(row);
  });
}

async function move(
  ctx: StaffContext, returnId: string, from: readonly ReturnStatus[], to: ReturnStatus,
  extra?: (tx: TenantTransaction, current: OrderReturn) => Promise<void>,
  set: { disposition?: Record<string, Disposition> } = {},
): Promise<OrderReturn> {
  return asStaff(ctx, async (tx) => {
    const current = await lockReturn(tx, ctx.accountId, returnId);
    if (!from.includes(current.status)) throw new OrderError(409, 'bad_transition', `A return cannot move from ${current.status} to ${to}`);
    if (extra) await extra(tx, current);
    const [row] = await tx.$queryRawUnsafe<ReturnDbRow[]>(
      `UPDATE order_returns SET status=$3, disposition=COALESCE($4::jsonb, disposition), updated_at=now()
       WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${RETURN_COLUMNS}`,
      ctx.accountId, returnId, to, set.disposition ? JSON.stringify(set.disposition) : null);
    await event(tx, ctx, current.order_id, `return_${to}`);
    await auditOrder(tx, ctx, `order.return_${to}`, returnId, { order_id: current.order_id });
    return toReturn(row);
  });
}

export async function receiveReturn(ctx: StaffContext, returnId: string): Promise<OrderReturn> {
  assertStaff(ctx);
  return move(ctx, returnId, ['requested'], 'received');
}

export async function rejectReturn(ctx: StaffContext, returnId: string): Promise<OrderReturn> {
  assertStaff(ctx);
  return move(ctx, returnId, ['requested', 'received'], 'rejected');
}

export async function inspectReturn(ctx: StaffContext, returnId: string, disposition: unknown): Promise<OrderReturn> {
  assertStaff(ctx);
  const current = await withTenant(ctx, (tx) => readReturn(tx, ctx.accountId, returnId));
  const parsed = parseDisposition(disposition, current.items);
  return move(ctx, returnId, ['received'], 'inspected', undefined, { disposition: parsed });
}

/** The 'restock' lines of an inspected return as stock lines (lines whose variant is gone are skipped). */
async function restockLines(tx: TenantTransaction, accountId: string, ret: OrderReturn) {
  const ids = ret.items.filter((l) => ret.disposition?.[l.order_item_id] === 'restock').map((l) => l.order_item_id);
  if (!ids.length) return [];
  const variants = await tx.$queryRaw<{ id: string; variant_id: string }[]>`SELECT id::text AS id, variant_id::text AS variant_id
    FROM order_items WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[]) AND variant_id IS NOT NULL`;
  const variantOf = new Map(variants.map((v) => [v.id, v.variant_id]));
  return ret.items.flatMap((l) => (ids.includes(l.order_item_id) && variantOf.has(l.order_item_id)
    ? [{ variantId: variantOf.get(l.order_item_id)!, quantity: l.qty }] : []));
}

/**
 * Close an inspected return (admin). With `restock`, and only when nothing was
 * restocked yet, the 'restock' lines go back on hand ('return_restock'):
 *   - no linked refund, or a linked refund that failed (it will not restock
 *     unless retried, and a processed retry then finds restocked_at set);
 *   - a processed refund already restocked, so the flag is a no-op;
 *   - a refund still in flight refuses (409): it restocks when processed;
 *   - an order whose units a whole-order refund already restocked
 *     ('refund_restocked' event) restocks nothing more.
 */
export async function closeReturn(ctx: StaffContext, returnId: string, input: { restock?: boolean } = {}): Promise<OrderReturn> {
  assertStaff(ctx);
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Only an admin can close a return');
  return move(ctx, returnId, ['inspected'], 'closed', async (tx, current) => {
    if (!input.restock || current.restocked_at) return;
    if (current.refund_id) {
      const [refund] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM customer_refunds
        WHERE account_id=${ctx.accountId}::uuid AND id=${current.refund_id}::uuid`;
      if (refund?.status === 'processed') return;
      if (refund && refund.status !== 'failed')
        throw new OrderError(409, 'conflict', 'The refund for this return is still in progress; it restocks when processed');
    }
    // A whole-order refund restock ('refund_restocked') already put every sold unit back.
    const [marker] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM order_events
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${current.order_id}::uuid AND kind='refund_restocked'`;
    const lines = (marker?.n ?? 0) > 0 ? [] : await restockLines(tx, ctx.accountId, current);
    if (lines.length) {
      await restockTx(tx, ctx.accountId, { orderId: current.order_id, lines, kind: 'return_restock', returnId, actorUserId: ctx.userId });
    }
    await tx.$executeRaw`UPDATE order_returns SET restocked_at=now() WHERE account_id=${ctx.accountId}::uuid AND id=${returnId}::uuid`;
  });
}

/**
 * Refund an inspected return (commerce.refunds): one refund on the order's
 * settled payment, linked to the return, restocking its 'restock' lines when
 * processed. The amount is the staff's choice, capped by the payment.
 */
export async function refundReturn(ctx: StaffContext, returnId: string, input: { amountMinor: number; note?: unknown }): Promise<{ refundId: string }> {
  assertStaff(ctx);
  await requirePermission(ctx, 'commerce.refunds');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new OrderError(400, 'invalid', 'Invalid amount');
  const note = cleanNote(input.note);
  const { paymentId } = await asStaff(ctx, async (tx) => {
    const current = await lockReturn(tx, ctx.accountId, returnId);
    if (current.status !== 'inspected') throw new OrderError(409, 'bad_transition', 'Inspect the return before refunding it');
    if (current.refund_id) throw new OrderError(409, 'conflict', 'This return already has a refund');
    const [payment] = await tx.$queryRaw<{ id: string; left: bigint }[]>`
      SELECT id::text AS id, amount_minor - refunded_minor AS left FROM customer_payments
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${current.order_id}::uuid AND status='captured' AND settlement='settled'
      ORDER BY created_at LIMIT 1`;
    if (!payment || (minorFromDb(payment.left) ?? 0) <= 0) throw new OrderError(409, 'conflict', 'No refundable payment on this order');
    return { paymentId: payment.id };
  });
  // Two refunds at once both pass the check above; the unique index on
  // customer_refunds(account_id, return_id) lets exactly one insert commit.
  const { refundId } = await requestRefund(ctx, { paymentId, amountMinor: input.amountMinor, reason: 'return', note, restock: true, returnId })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new OrderError(409, 'conflict', 'This return already has a refund');
      throw error;
    });
  await asStaff(ctx, async (tx) => {
    await tx.$executeRaw`UPDATE order_returns SET refund_id=${refundId}::uuid, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${returnId}::uuid AND refund_id IS NULL`;
    const current = await lockReturn(tx, ctx.accountId, returnId);
    await event(tx, ctx, current.order_id, 'return_refund_requested');
    await auditOrder(tx, ctx, 'order.return_refund_requested', returnId, { refund_id: refundId });
  });
  return { refundId };
}

async function readReturn(tx: TenantTransaction, accountId: string, returnId: string): Promise<OrderReturn> {
  if (!UUID.test(returnId)) throw new OrderError(404, 'not_found', 'Return not found');
  const [row] = await tx.$queryRawUnsafe<ReturnDbRow[]>(
    `SELECT ${RETURN_COLUMNS} FROM order_returns WHERE account_id=$1::uuid AND id=$2::uuid`, accountId, returnId);
  if (!row) throw new OrderError(404, 'not_found', 'Return not found');
  return toReturn(row);
}

export async function getReturn(ctx: TenantContext, returnId: string): Promise<OrderReturn> {
  return withTenant(ctx, (tx) => readReturn(tx, ctx.accountId, returnId));
}

export async function listOrderReturns(ctx: TenantContext, orderId: string): Promise<OrderReturn[]> {
  if (!UUID.test(orderId)) throw new OrderError(404, 'not_found', 'Order not found');
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRawUnsafe<ReturnDbRow[]>(
      `SELECT ${RETURN_COLUMNS} FROM order_returns WHERE account_id=$1::uuid AND order_id=$2::uuid ORDER BY created_at`,
      ctx.accountId, orderId);
    // No returns: answer an unknown or another workspace's order as not found, not as an empty list.
    if (!rows.length) {
      const order = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
      if (!order.length) throw new OrderError(404, 'not_found', 'Order not found');
    }
    return rows.map(toReturn);
  });
}
