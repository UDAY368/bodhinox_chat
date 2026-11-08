// Shipment creation (Phase 9, design §2 "Shipment", D7, D10, D12, D16). Owner: T4.
//
// Creating a shipment spends the Shiprocket wallet (at AWB assignment): it is
// always an explicit staff action (commerce.shipments, admin ceiling), never
// automatic. The row is inserted as `creating` with our random reference (sent
// as Shiprocket's channel order_id) and the job is queued in the same
// transaction, after locking the order.
//
// The job is a claimed state machine (claim_token + claimed_until), not
// dispatchOnce: provider HTTP runs outside any transaction and every result is
// written `WHERE claim_token = <mine>`. An ambiguous create (timeout, 5xx) is
// reconciled by our reference and an ambiguous AWB assignment is only ever
// adopted, never repeated: a second assignment charges the wallet twice.
// Lock order everywhere: order, then shipment.
//
// Logs carry ids and codes only; no address, phone, email or provider message.
//
// Shiprocket details not confirmed (design §0): the adhoc field names and
// units (weight in kg, amounts in rupees), the AWB response shape
// (response.data.awb_code), the order search used for reconcile
// (GET /orders?search=<reference> matching channel_order_id) and the order
// detail shape (GET /orders/show/<id>). The parsers below accept the shapes we
// know of and treat anything else as "not found" (never as success).
import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/auth/permissions';
import { requireFeature } from '@/lib/billing/entitlements';
import { isUniqueViolation } from '@/lib/commerce/returns';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx, orderEventTx } from '@/lib/payments/ledger';
import { openShipmentException } from './exceptions';
import { loadCourierSecrets, validDims } from './connection';
import { shiprocketCall, shiprocketDisabled, ShiprocketError } from './shiprocket-client';
import { TRACKING_RANK } from './status-map';
import {
  CREATE_SHIPMENT_JOB, ShipmentError, type FulfilmentActor, type FulfilmentJobMeta, type OrderShipmentView, type ShipmentAwbState,
  type ShipmentCreateState, type ShipmentDims, type ShipmentJobPayload, type TrackingStatus,
} from './types';

/** Longer than the 15 s HTTP timeout plus margin; an expired claim means the outcome is unknown. */
export const SHIPMENT_CLAIM_MS = 60_000;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SR_ID = /^[0-9]{1,20}$/;
const AWB = /^[A-Za-z0-9-]{4,40}$/;

/** A shipment reference: `bx` + 12 random lower-case letters and digits (fits the CHECK). */
export function newShipmentReference(): string {
  const bytes = randomBytes(12);
  let out = 'bx';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** The job claimed this shipment and the other job is still inside its HTTP call: back off and retry. */
export class ShipmentBusyError extends Error {
  constructor() {
    super('shipment_claimed');
    this.name = 'ShipmentBusyError';
  }
}

const asWorker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>, userId?: string) =>
  withTenant({ accountId, userId, role: 'owner' }, work, getWorkerPrisma());

interface ShipmentRow {
  id: string;
  order_id: string;
  connection_id: string;
  reference: string;
  create_state: ShipmentCreateState;
  awb_state: ShipmentAwbState;
  claim_token: string | null;
  claimed: boolean;
  sr_order_id: string | null;
  sr_shipment_id: string | null;
  awb: string | null;
  tracking_rank: number | null;
  length_cm: Prisma.Decimal | number;
  breadth_cm: Prisma.Decimal | number;
  height_cm: Prisma.Decimal | number;
  weight_grams: number;
}

const SHIPMENT_COLUMNS = Prisma.sql`id::text AS id, order_id::text AS order_id, connection_id::text AS connection_id, reference,
  create_state, awb_state, claim_token::text AS claim_token, COALESCE(claimed_until > now(), false) AS claimed, sr_order_id,
  sr_shipment_id, awb, tracking_rank, length_cm, breadth_cm, height_cm, weight_grams`;

async function lockShipment(tx: TenantTransaction, accountId: string, shipmentId: string): Promise<ShipmentRow | null> {
  const [row] = await tx.$queryRaw<ShipmentRow[]>`SELECT ${SHIPMENT_COLUMNS} FROM order_shipments
    WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid FOR UPDATE`;
  return row ?? null;
}

interface OrderRow {
  id: string;
  status: string;
  source: string;
  currency: string;
  shipping_address: unknown;
  contact_email: string | null;
  created_at: Date;
  total_minor: bigint | number | null;
  shipping_minor: bigint | number;
  discount_minor: bigint | number;
  /** A cash-on-delivery order whose cash is not recorded: it ships unpaid and the courier collects the total. */
  unpaid_cod: boolean;
}

/** Locks the order row first (D16), with what a shipment needs. */
async function lockOrderRow(tx: TenantTransaction, accountId: string, orderId: string): Promise<OrderRow | null> {
  const [row] = await tx.$queryRaw<OrderRow[]>`SELECT o.id::text AS id, o.status, o.source, o.currency, o.shipping_address,
      c.email AS contact_email, o.created_at, o.total_minor, o.shipping_minor, o.discount_minor,
      (o.payment_method='cod' AND o.paid_at IS NULL AND o.priced_at IS NOT NULL) AS unpaid_cod
    FROM orders o LEFT JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
    WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid FOR UPDATE OF o`;
  return row ?? null;
}

/** Ready to hand to the courier: paid, or an unpaid cash-on-delivery order still confirmed. */
const readyToShip = (order: Pick<OrderRow, 'status' | 'unpaid_cod'>): boolean =>
  order.status === 'paid' || (order.status === 'confirmed' && order.unpaid_cod);

/** Refunds that will restock the whole order when processed (not a return's), still in flight (as order-lifecycle). */
async function restockRefundInFlight(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND restock AND return_id IS NULL
      AND status IN ('requested','sending','pending','unknown')`;
  return (row?.n ?? 0) > 0;
}

/**
 * Queues (or re-arms a finished) create job for the shipment, in the caller's
 * transaction. Re-arming is how "Assign courier again" and the sweep resume a
 * shipment; the job itself decides what is left to do from the row.
 */
async function enqueueCreateJob(tx: TenantTransaction, accountId: string, shipmentId: string, runAt: Date = new Date()): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, run_at, max_attempts)
    VALUES(${CREATE_SHIPMENT_JOB}, ${accountId}::uuid, ${JSON.stringify({ shipmentId })}::jsonb, ${`shpcreate:${shipmentId}`}, ${runAt}, 5)
    ON CONFLICT (dedupe_key) DO UPDATE SET status='pending', attempts=0, run_at=EXCLUDED.run_at, lease_until=NULL,
      lease_token=NULL, last_error=NULL, updated_at=now()
    WHERE jobs.status IN ('done','failed') AND jobs.type=EXCLUDED.type AND jobs.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id`;
}

// ---------------------------------------------------------------- address and payload

interface Address {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);

/** The storefront address snapshot, or null when it cannot ship within India (address_incomplete). */
export function shippableAddress(raw: unknown): Address | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const country = str(a.country, 2)?.toUpperCase();
  const digits = typeof a.phone === 'string' ? a.phone.replace(/\D/g, '') : '';
  const phone = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  const postal = str(a.postal_code, 12);
  const out = {
    name: str(a.name, 200), line1: str(a.line1, 300), line2: str(a.line2, 300), city: str(a.city, 100), state: str(a.state, 100),
    postal_code: postal,
  };
  if (country !== 'IN' || !out.name || !out.line1 || !out.city || !out.state || !postal || !/^[1-9][0-9]{5}$/.test(postal)) return null;
  if (!/^[6-9][0-9]{9}$/.test(phone)) return null;
  return { ...out, name: out.name, line1: out.line1, city: out.city, state: out.state, postal_code: postal, country: 'IN', phone };
}

const rupees = (minor: bigint | number | null | undefined): number => Math.round(Number(minor ?? 0)) / 100;

/** Asia/Kolkata `YYYY-MM-DD HH:mm` (Shiprocket's order_date). */
function istDate(date: Date): string {
  const ist = new Date(new Date(date).getTime() + 330 * 60_000);
  return ist.toISOString().slice(0, 16).replace('T', ' ');
}

interface ItemRow {
  id: string;
  name: string | null;
  sku: string | null;
  hsn_code: string | null;
  quantity: number;
  unit_price_minor: bigint | number;
  tax_rate_bps: number | null;
  discount_minor: bigint | number | null;
}

async function adhocPayload(tx: TenantTransaction, accountId: string, order: OrderRow, shipment: ShipmentRow, pickup: string, apiEmail: string) {
  const address = shippableAddress(order.shipping_address);
  if (!address || order.currency !== 'INR') return null;
  const items = await tx.$queryRaw<ItemRow[]>`SELECT id::text AS id, name, sku, hsn_code, quantity, unit_price_minor, tax_rate_bps, discount_minor
    FROM order_items WHERE account_id=${accountId}::uuid AND order_id=${order.id}::uuid ORDER BY id`;
  if (!items.length) return null;
  const [first, ...rest] = address.name.split(/\s+/);
  const email = order.contact_email && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(order.contact_email) ? order.contact_email : apiEmail;
  const total = order.total_minor ?? 0;
  return {
    order_id: shipment.reference,
    order_date: istDate(order.created_at),
    pickup_location: pickup,
    billing_customer_name: first.slice(0, 50),
    billing_last_name: rest.join(' ').slice(0, 50),
    billing_address: address.line1,
    billing_address_2: address.line2 ?? '',
    billing_city: address.city,
    billing_pincode: address.postal_code,
    billing_state: address.state,
    billing_country: 'India',
    billing_email: email,
    billing_phone: address.phone,
    shipping_is_billing: true,
    order_items: items.map((i) => ({
      name: (i.name ?? 'Item').slice(0, 200),
      sku: (i.sku ?? `bx-${i.id.slice(0, 8)}`).slice(0, 50),
      units: i.quantity,
      selling_price: rupees(i.unit_price_minor),
      discount: rupees(i.discount_minor),
      tax: i.tax_rate_bps ? i.tax_rate_bps / 100 : 0,
      ...(i.hsn_code && /^[0-9]{4,8}$/.test(i.hsn_code) ? { hsn: i.hsn_code } : {}),
    })),
    // The courier collects the order total (COD fee included in sub_total) for an unpaid COD order.
    payment_method: order.unpaid_cod ? 'COD' : 'Prepaid',
    shipping_charges: rupees(order.shipping_minor),
    total_discount: rupees(order.discount_minor),
    // Shiprocket takes total = sub_total + shipping_charges - total_discount, so sub_total is before the discount
    // (total_minor is after it); for COD that total is what the courier collects.
    sub_total: rupees(BigInt(total) - BigInt(order.shipping_minor ?? 0) + BigInt(order.discount_minor ?? 0)),
    length: Number(shipment.length_cm),
    breadth: Number(shipment.breadth_cm),
    height: Number(shipment.height_cm),
    weight: shipment.weight_grams / 1000,
  };
}

// ---------------------------------------------------------------- response parsers (defensive)

const srId = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : typeof v === 'string' ? v.trim() : null;
  return s && SR_ID.test(s) ? s : null;
};
const awbOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : null;
  return s && AWB.test(s) ? s : null;
};
const courierOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);
/** Shiprocket ids are sent as numbers when they fit, else as the digit string. */
const idValue = (id: string): number | string => (Number.isSafeInteger(Number(id)) ? Number(id) : id);

export function parseAdhocCreate(body: unknown): { srOrderId: string; srShipmentId: string } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const srOrderId = srId(b.order_id);
  const srShipmentId = srId(b.shipment_id);
  return srOrderId && srShipmentId ? { srOrderId, srShipmentId } : null;
}

/** assigned: AWB and courier; refused: Shiprocket answered 2xx with awb_assign_status 0; null: unclear. */
export function parseAwbAssign(body: unknown): { kind: 'assigned'; awb: string; courier: string | null } | { kind: 'refused' } | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = ((b.response as Record<string, unknown> | undefined)?.data ?? b.data ?? b) as Record<string, unknown>;
  const awb = awbOf(data?.awb_code) ?? awbOf(b.awb_code);
  if (awb) return { kind: 'assigned', awb, courier: courierOf(data?.courier_name) ?? courierOf(b.courier_name) };
  if (b.awb_assign_status === 0 || b.awb_assign_status === '0') return { kind: 'refused' };
  return null;
}

export interface FoundOrder {
  srOrderId: string;
  srShipmentId: string | null;
  awb: string | null;
  courier: string | null;
}

function shipmentsOf(entry: Record<string, unknown>): Record<string, unknown>[] {
  const s = entry.shipments;
  if (Array.isArray(s)) return s.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  return s && typeof s === 'object' ? [s as Record<string, unknown>] : [];
}

function toFound(entry: Record<string, unknown>): FoundOrder | null {
  const srOrderId = srId(entry.id) ?? srId(entry.order_id);
  if (!srOrderId) return null;
  const ship = shipmentsOf(entry)[0] ?? {};
  const awbData = (entry.awb_data ?? {}) as Record<string, unknown>;
  return {
    srOrderId,
    srShipmentId: srId(ship.id) ?? srId(entry.shipment_id),
    awb: awbOf(ship.awb) ?? awbOf(ship.awb_code) ?? awbOf(awbData.awb) ?? awbOf(entry.awb_code),
    courier: courierOf(ship.courier) ?? courierOf(ship.courier_name) ?? courierOf(entry.courier_name),
  };
}

/** The order with our reference as channel_order_id in a GET /orders?search= result (exact match only). */
export function findByReference(body: unknown, reference: string): FoundOrder | null {
  const data = (body as { data?: unknown } | null)?.data;
  const list = Array.isArray(data) ? data : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.channel_order_id === reference) return toFound(e);
  }
  return null;
}

/** The order detail of GET /orders/show/<id>, only when it is the expected order. */
export function parseOrderShow(body: unknown, srOrderId: string): FoundOrder | null {
  const data = (body as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const found = toFound(data as Record<string, unknown>);
  return found && found.srOrderId === srOrderId ? found : null;
}

// ---------------------------------------------------------------- staff actions

async function requireShipper(ctx: FulfilmentActor): Promise<void> {
  await requirePermission(ctx, 'commerce.shipments');
}

async function requireAvailable(ctx: FulfilmentActor): Promise<void> {
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  await withTenant(ctx, (tx) => requireFeature(tx, ctx.accountId, 'courier_shipping'));
}

const LIVE = Prisma.sql`create_state NOT IN ('failed','cancelled')`;

/** Locks the order; refuses unless paid, no live shipment, no refund in flight, INR / IN / state present. Queues the create job. */
export async function requestShipment(ctx: FulfilmentActor, orderId: string, dims: ShipmentDims): Promise<{ shipmentId: string }> {
  await requireShipper(ctx);
  const valid = validDims(dims ?? ({} as ShipmentDims), true) as ShipmentDims;
  await requireAvailable(ctx);
  try {
    return await asWorker(ctx.accountId, async (tx) => {
      const [connection] = await tx.$queryRaw<{ id: string; status: string; pickup: string | null }[]>`
        SELECT id::text AS id, status, pickup_location AS pickup FROM courier_connections
        WHERE account_id=${ctx.accountId}::uuid AND status<>'disconnected' LIMIT 1`;
      if (!connection || connection.status !== 'active' || !connection.pickup) throw new ShipmentError('not_connected');
      const order = await lockOrderRow(tx, ctx.accountId, orderId);
      if (!order) throw new ShipmentError('not_found');
      // Shopify and WooCommerce orders are fulfilled by their own stores (design §11).
      if (order.source === 'shopify' || order.source === 'woocommerce') throw new ShipmentError('invalid');
      if (!readyToShip(order)) throw new ShipmentError('order_not_paid');
      const [live] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_shipments
        WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND ${LIVE} LIMIT 1`;
      if (live) throw new ShipmentError('shipment_exists');
      if (await restockRefundInFlight(tx, ctx.accountId, orderId)) throw new ShipmentError('refund_in_flight');
      if (order.currency !== 'INR' || !shippableAddress(order.shipping_address)) throw new ShipmentError('address_incomplete');

      const shipmentId = randomUUID();
      const reference = newShipmentReference();
      await tx.$executeRaw`INSERT INTO order_shipments(id, account_id, order_id, connection_id, reference, length_cm, breadth_cm,
          height_cm, weight_grams, created_by)
        VALUES(${shipmentId}::uuid, ${ctx.accountId}::uuid, ${orderId}::uuid, ${connection.id}::uuid, ${reference}, ${valid.length_cm},
          ${valid.breadth_cm}, ${valid.height_cm}, ${valid.weight_grams}, ${ctx.userId}::uuid)`;
      await enqueueCreateJob(tx, ctx.accountId, shipmentId);
      await orderEventTx(tx, ctx.accountId, orderId, 'shipment_created', { actorUserId: ctx.userId });
      await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.shipment_create', shipmentId, { orderId });
      return { shipmentId };
    }, ctx.userId);
  } catch (error) {
    // The partial unique index is the race backstop for the live-shipment check.
    if (isUniqueViolation(error)) throw new ShipmentError('shipment_exists');
    throw error;
  }
}

/** Staff "Assign courier again" after a definite AWB refusal (never after an ambiguous one). */
export async function reassignAwb(ctx: FulfilmentActor, orderId: string): Promise<void> {
  await requireShipper(ctx);
  await requireAvailable(ctx);
  await asWorker(ctx.accountId, async (tx) => {
    const order = await lockOrderRow(tx, ctx.accountId, orderId);
    if (!order) throw new ShipmentError('not_found');
    if (!readyToShip(order)) throw new ShipmentError('order_not_paid');
    if (await restockRefundInFlight(tx, ctx.accountId, orderId)) throw new ShipmentError('refund_in_flight');
    const [row] = await tx.$queryRaw<ShipmentRow[]>`SELECT ${SHIPMENT_COLUMNS} FROM order_shipments
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND ${LIVE} LIMIT 1 FOR UPDATE`;
    if (!row) throw new ShipmentError('not_found');
    // Only a definite refusal ('failed') may be repeated: 'unknown' could already have charged the wallet.
    if (row.create_state !== 'created' || row.awb_state !== 'failed' || row.claimed) throw new ShipmentError('conflict');
    await tx.$executeRaw`UPDATE order_shipments SET awb_state='none', last_error_code=NULL, claim_token=NULL, claimed_until=NULL
      WHERE account_id=${ctx.accountId}::uuid AND id=${row.id}::uuid`;
    await enqueueCreateJob(tx, ctx.accountId, row.id);
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.shipment_awb_retry', row.id, { orderId });
  }, ctx.userId);
}

function staffProviderFailure(error: unknown): never {
  if (error instanceof ShiprocketError) {
    if (error.kind === 'auth') throw new ShipmentError('auth');
    if (error.kind === 'throttled') throw new ShipmentError('throttled');
    if (error.kind === 'rejected') throw new ShipmentError('conflict');
    throw new ShipmentError('provider_unreachable');
  }
  throw error;
}

/** Staff cancel, only before pickup; the order stays paid. */
export async function cancelShipment(ctx: FulfilmentActor, orderId: string): Promise<void> {
  await requireShipper(ctx);
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  const token = randomUUID();
  // Claim the row so the create job cannot assign an AWB while Shiprocket cancels the order.
  const claimed = await asWorker(ctx.accountId, async (tx) => {
    const order = await lockOrderRow(tx, ctx.accountId, orderId);
    if (!order) throw new ShipmentError('not_found');
    const [row] = await tx.$queryRaw<ShipmentRow[]>`SELECT ${SHIPMENT_COLUMNS} FROM order_shipments
      WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND ${LIVE} LIMIT 1 FOR UPDATE`;
    if (!row) throw new ShipmentError('not_found');
    if (row.create_state !== 'created' || !row.sr_order_id || row.claimed || row.awb_state === 'assigning' || row.awb_state === 'unknown'
      || (row.tracking_rank ?? 0) >= TRACKING_RANK.picked_up) throw new ShipmentError('conflict');
    await tx.$executeRaw`UPDATE order_shipments SET claim_token=${token}::uuid,
        claimed_until=now() + (${SHIPMENT_CLAIM_MS}::int * interval '1 millisecond')
      WHERE account_id=${ctx.accountId}::uuid AND id=${row.id}::uuid`;
    return row;
  }, ctx.userId);

  try {
    await shiprocketCall(ctx.accountId, 'POST', '/orders/cancel', { ids: [idValue(claimed.sr_order_id!)] });
  } catch (error) {
    await asWorker(ctx.accountId, (tx) => tx.$executeRaw`UPDATE order_shipments SET claim_token=NULL, claimed_until=NULL
      WHERE account_id=${ctx.accountId}::uuid AND id=${claimed.id}::uuid AND claim_token=${token}::uuid`);
    if (error instanceof ShipmentError) throw error;
    return staffProviderFailure(error);
  }

  await asWorker(ctx.accountId, async (tx) => {
    await lockOrderRow(tx, ctx.accountId, orderId);
    const count = await tx.$executeRaw`UPDATE order_shipments SET create_state='cancelled', tracking_status='cancelled',
        tracking_rank=${TRACKING_RANK.cancelled}, claim_token=NULL, claimed_until=NULL
      WHERE account_id=${ctx.accountId}::uuid AND id=${claimed.id}::uuid AND claim_token=${token}::uuid`;
    if (count !== 1) throw new ShipmentError('conflict');
    await orderEventTx(tx, ctx.accountId, orderId, 'shipment_cancelled', { actorUserId: ctx.userId });
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.shipment_cancel', claimed.id, { orderId });
  }, ctx.userId);
}

/** A short-lived label URL for the browser (never stored). */
export async function labelUrl(ctx: FulfilmentActor, orderId: string): Promise<string> {
  await requireShipper(ctx);
  if (shiprocketDisabled()) throw new ShipmentError('not_configured');
  const row = await asWorker(ctx.accountId, async (tx) => (await tx.$queryRaw<ShipmentRow[]>`SELECT ${SHIPMENT_COLUMNS} FROM order_shipments
    WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND ${LIVE} LIMIT 1`)[0] ?? null);
  if (!row) throw new ShipmentError('not_found');
  if (row.awb_state !== 'assigned' || !row.sr_shipment_id) throw new ShipmentError('conflict');
  let body: unknown;
  try {
    body = await shiprocketCall(ctx.accountId, 'POST', '/courier/generate/label', { shipment_id: [idValue(row.sr_shipment_id)] });
  } catch (error) {
    if (error instanceof ShipmentError) throw error;
    return staffProviderFailure(error);
  }
  const url = (body as { label_url?: unknown } | null)?.label_url;
  if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\//.test(url)) throw new ShipmentError('provider_unreachable');
  try { new URL(url); } catch { throw new ShipmentError('provider_unreachable'); }
  return url;
}

// ---------------------------------------------------------------- the create job

type Step =
  | { kind: 'done' }
  | { kind: 'busy' }
  | { kind: 'reconcile' }
  | { kind: 'create'; token: string; payload: NonNullable<Awaited<ReturnType<typeof adhocPayload>>> }
  | { kind: 'awb'; token: string; srShipmentId: string };

async function claimStep(accountId: string, shipmentId: string): Promise<Step> {
  return asWorker(accountId, async (tx) => {
    // Order first, then shipment (D16): read the order id without a lock, then lock both in order.
    const [ref] = await tx.$queryRaw<{ order_id: string }[]>`SELECT order_id::text AS order_id FROM order_shipments
      WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
    if (!ref) return { kind: 'done' } as Step;
    const order = await lockOrderRow(tx, accountId, ref.order_id);
    const row = await lockShipment(tx, accountId, shipmentId);
    if (!order || !row) return { kind: 'done' } as Step;
    const fail = async (column: 'create_state' | 'awb_state', code: string): Promise<Step> => {
      if (column === 'create_state')
        await tx.$executeRaw`UPDATE order_shipments SET create_state='failed', last_error_code=${code}, claim_token=NULL, claimed_until=NULL
          WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
      else
        await tx.$executeRaw`UPDATE order_shipments SET awb_state='failed', last_error_code=${code}, claim_token=NULL, claimed_until=NULL
          WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
      return { kind: 'done' };
    };
    const claim = async (setAssigning: boolean): Promise<string> => {
      const token = randomUUID();
      await tx.$executeRaw`UPDATE order_shipments SET claim_token=${token}::uuid,
          claimed_until=now() + (${SHIPMENT_CLAIM_MS}::int * interval '1 millisecond'),
          awb_state=CASE WHEN ${setAssigning} THEN 'assigning' ELSE awb_state END
        WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
      return token;
    };
    const expired = row.claim_token !== null && !row.claimed;
    const [conn] = await tx.$queryRaw<{ id: string; status: string; pickup: string | null; email: string }[]>`
      SELECT id::text AS id, status, pickup_location AS pickup, api_email AS email FROM courier_connections
      WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
    const connected = !!conn && conn.id === row.connection_id && conn.status === 'active';
    // The row's connection is gone for good (disconnected, or replaced by a reconnect): reconcile can never run for it
    // and the sweep only looks at the live connection, so an ambiguous outcome needs staff now.
    const orphaned = !conn || conn.id !== row.connection_id;

    if (row.create_state === 'failed' || row.create_state === 'cancelled') return { kind: 'done' };
    if (row.create_state === 'creating' || row.create_state === 'unknown') {
      if (row.claimed) return { kind: 'busy' };
      if (row.create_state === 'unknown' || expired) {
        if (row.create_state === 'creating')
          await tx.$executeRaw`UPDATE order_shipments SET create_state='unknown', claim_token=NULL, claimed_until=NULL
            WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
        if (orphaned) await openShipmentException(tx, accountId, shipmentId, 'create_unknown', null, { once: true });
        return connected ? { kind: 'reconcile' } : { kind: 'done' };
      }
      // Never sent: safe to refuse without any provider call.
      if (!connected) return fail('create_state', conn && conn.id === row.connection_id ? 'auth' : 'not_connected');
      if (!readyToShip(order)) return fail('create_state', 'order_not_paid');
      if (await restockRefundInFlight(tx, accountId, order.id)) return fail('create_state', 'refund_in_flight');
      const payload = await adhocPayload(tx, accountId, order, row, conn!.pickup ?? '', conn!.email);
      if (!payload || !conn!.pickup) return fail('create_state', 'address_incomplete');
      return { kind: 'create', token: await claim(false), payload };
    }
    // created
    if (row.awb_state === 'assigned' || row.awb_state === 'failed') return { kind: 'done' };
    if (row.claimed) return { kind: 'busy' };
    if (row.awb_state === 'unknown' || (row.awb_state === 'assigning' && expired)) {
      if (row.awb_state === 'assigning')
        await tx.$executeRaw`UPDATE order_shipments SET awb_state='unknown', claim_token=NULL, claimed_until=NULL
          WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
      if (orphaned) await openShipmentException(tx, accountId, shipmentId, 'awb_unknown', null, { once: true });
      return connected ? { kind: 'reconcile' } : { kind: 'done' };
    }
    // awb_state none (or a claimless 'assigning', which cannot have been sent).
    if (!connected) return { kind: 'done' };
    // The AWB spends the wallet: only for an order still paid or an unpaid COD order still confirmed (or already marked
    // dispatched by staff) and not being refunded.
    if (!readyToShip(order) && order.status !== 'dispatched') return fail('awb_state', 'order_not_paid');
    if (await restockRefundInFlight(tx, accountId, order.id)) return fail('awb_state', 'refund_in_flight');
    if (!row.sr_shipment_id) return { kind: 'done' };
    return { kind: 'awb', token: await claim(true), srShipmentId: row.sr_shipment_id };
  });
}

/** Writes a result only while our claim still holds; returns whether it did. */
async function settle(accountId: string, shipmentId: string, token: string, work: (tx: TenantTransaction) => Promise<number>): Promise<boolean> {
  return asWorker(accountId, async (tx) => {
    const [ref] = await tx.$queryRaw<{ order_id: string }[]>`SELECT order_id::text AS order_id FROM order_shipments
      WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`;
    if (!ref) return false;
    await lockOrderRow(tx, accountId, ref.order_id);
    const row = await lockShipment(tx, accountId, shipmentId);
    if (!row || row.claim_token !== token) return false;
    return (await work(tx)) === 1;
  });
}

const where = (accountId: string, shipmentId: string, token: string) =>
  Prisma.sql`account_id=${accountId}::uuid AND id=${shipmentId}::uuid AND claim_token=${token}::uuid`;

async function recordAwb(tx: TenantTransaction, accountId: string, shipmentId: string, awb: string, courier: string | null, extra: Prisma.Sql) {
  const count = await tx.$executeRaw`UPDATE order_shipments SET awb_state='assigned', awb=${awb}, courier_name=${courier},
      tracking_status=CASE WHEN COALESCE(tracking_rank, 0) < ${TRACKING_RANK.awb_assigned} THEN 'awb_assigned' ELSE tracking_status END,
      tracking_event_at=CASE WHEN COALESCE(tracking_rank, 0) < ${TRACKING_RANK.awb_assigned} THEN now() ELSE tracking_event_at END,
      tracking_rank=GREATEST(COALESCE(tracking_rank, 0), ${TRACKING_RANK.awb_assigned}), claim_token=NULL, claimed_until=NULL,
      last_error_code=NULL
    WHERE ${extra}`;
  if (count === 1) {
    const status: TrackingStatus = 'awb_assigned';
    await tx.$executeRaw`INSERT INTO shipment_tracking_events(account_id, shipment_id, status, provider_code, event_at, source)
      VALUES(${accountId}::uuid, ${shipmentId}::uuid, ${status}, 'awb_assigned', date_trunc('second', now()), 'create')
      ON CONFLICT (account_id, shipment_id, provider_code, event_at) DO NOTHING`;
  }
  return count;
}

/** Requests the pickup after an AWB; a failure is recorded on the shipment, never fatal. */
async function requestPickup(accountId: string, shipmentId: string, srShipmentId: string): Promise<void> {
  try {
    await shiprocketCall(accountId, 'POST', '/courier/generate/pickup', { shipment_id: [idValue(srShipmentId)] });
  } catch (error) {
    console.error('[shipments] pickup request failed', { shipmentId, kind: error instanceof ShiprocketError ? error.kind : 'error' });
    await asWorker(accountId, (tx) => tx.$executeRaw`UPDATE order_shipments SET last_error_code='pickup_failed'
      WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid AND awb_state='assigned'`);
  }
}

/** Not connected / switched off between the claim and the call: no HTTP happened, release the claim. */
async function release(accountId: string, shipmentId: string, token: string, awb: boolean): Promise<void> {
  await settle(accountId, shipmentId, token, (tx) => awb
    ? tx.$executeRaw`UPDATE order_shipments SET awb_state='none', claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`
    : tx.$executeRaw`UPDATE order_shipments SET claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
}

async function runCreate(accountId: string, shipmentId: string, token: string, payload: object): Promise<'next' | 'stop' | 'reconcile'> {
  let body: unknown;
  try {
    body = await shiprocketCall(accountId, 'POST', '/orders/create/adhoc', payload);
  } catch (error) {
    if (error instanceof ShipmentError) { await release(accountId, shipmentId, token, false); return 'stop'; }
    if (!(error instanceof ShiprocketError)) throw error;
    // Throttled, or the login failed so the create was never sent: release and let the job retry with backoff.
    if (error.kind === 'throttled' || error.kind === 'unavailable') { await release(accountId, shipmentId, token, false); throw error; }
    if ((error.kind === 'rejected' && error.code !== 'duplicate_order') || error.kind === 'auth') {
      const code = error.kind === 'auth' ? 'auth' : error.code ?? 'provider_rejected';
      await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET create_state='failed',
          last_error_code=${code}, claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
      return 'stop';
    }
    // Timeout, 5xx or "this order id already exists": the order may exist at Shiprocket. Reconcile, never re-send.
    await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET create_state='unknown',
        last_error_code=NULL, claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
    return 'reconcile';
  }
  const created = parseAdhocCreate(body);
  if (!created) {
    await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET create_state='unknown',
        claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
    return 'reconcile';
  }
  const ok = await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET create_state='created',
      sr_order_id=${created.srOrderId}, sr_shipment_id=${created.srShipmentId}, last_error_code=NULL, claim_token=NULL, claimed_until=NULL
    WHERE ${where(accountId, shipmentId, token)}`);
  if (!ok) console.error('[shipments] create result arrived after the claim was lost', { shipmentId });
  return ok ? 'next' : 'stop';
}

async function runAwb(accountId: string, shipmentId: string, token: string, srShipmentId: string): Promise<'stop' | 'reconcile'> {
  let body: unknown;
  try {
    body = await shiprocketCall(accountId, 'POST', '/courier/assign/awb', { shipment_id: idValue(srShipmentId) });
  } catch (error) {
    if (error instanceof ShipmentError) { await release(accountId, shipmentId, token, true); return 'stop'; }
    if (!(error instanceof ShiprocketError)) throw error;
    if (error.kind === 'throttled' || error.kind === 'unavailable') { await release(accountId, shipmentId, token, true); throw error; }
    if (error.kind === 'rejected' || error.kind === 'auth') {
      // A definite refusal charged nothing: staff may "Assign courier again".
      const code = error.kind === 'auth' ? 'auth' : error.code ?? 'awb_refused';
      await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET awb_state='failed',
          last_error_code=${code}, claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
      return 'stop';
    }
    await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET awb_state='unknown',
        claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
    return 'reconcile';
  }
  const result = parseAwbAssign(body);
  if (result?.kind === 'assigned') {
    let ok: boolean;
    try {
      ok = await settle(accountId, shipmentId, token, (tx) => recordAwb(tx, accountId, shipmentId, result.awb, result.courier,
        where(accountId, shipmentId, token)));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The AWB already belongs to another shipment of this workspace: staff must look; never assign again.
      await settle(accountId, shipmentId, token, async (tx) => {
        const count = await tx.$executeRaw`UPDATE order_shipments SET awb_state='unknown', last_error_code='awb_conflict',
            claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`;
        await openShipmentException(tx, accountId, shipmentId, 'awb_unknown');
        return count;
      });
      return 'stop';
    }
    if (ok) await requestPickup(accountId, shipmentId, srShipmentId);
    return 'stop';
  }
  if (result?.kind === 'refused') {
    await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET awb_state='failed',
        last_error_code='awb_refused', claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
    return 'stop';
  }
  await settle(accountId, shipmentId, token, (tx) => tx.$executeRaw`UPDATE order_shipments SET awb_state='unknown',
      claim_token=NULL, claimed_until=NULL WHERE ${where(accountId, shipmentId, token)}`);
  return 'reconcile';
}

/** commerce.create_shipment job: adhoc order, then AWB and pickup. */
export async function handleCreateShipmentJob(accountId: string, payload: ShipmentJobPayload, meta: FulfilmentJobMeta): Promise<void> {
  if (shiprocketDisabled()) return;
  const final = meta.attempts >= meta.maxAttempts;
  // At most: create, AWB (plus a reconcile in between).
  for (let round = 0; round < 4; round += 1) {
    const step = await claimStep(accountId, payload.shipmentId);
    if (step.kind === 'done') return;
    if (step.kind === 'busy') throw new ShipmentBusyError();
    if (step.kind === 'reconcile') {
      const outcome = await reconcileShipment(accountId, payload.shipmentId, { openException: final });
      if (outcome === 'adopted') continue;
      if (outcome === 'unknown' && !final) throw new Error('shipment_outcome_unknown');
      return;
    }
    if (step.kind === 'create') {
      const next = await runCreate(accountId, payload.shipmentId, step.token, step.payload);
      if (next === 'stop') return;
      continue;
    }
    if ((await runAwb(accountId, payload.shipmentId, step.token, step.srShipmentId)) === 'stop') return;
  }
}

/**
 * Reconciles an unknown create or AWB by reference (adopts, or opens an
 * exception when `openException`; the sweep passes true, the job only on its
 * final attempt). Never creates and never assigns. 'skipped' when there was
 * nothing ambiguous, the claim is still held, or Shiprocket is not reachable
 * for this workspace.
 */
export async function reconcileShipment(
  accountId: string, shipmentId: string, opts: { openException?: boolean } = { openException: true },
): Promise<'adopted' | 'unknown' | 'skipped'> {
  if (shiprocketDisabled()) return 'skipped';
  const row = await asWorker(accountId, async (tx) => (await tx.$queryRaw<ShipmentRow[]>`SELECT ${SHIPMENT_COLUMNS} FROM order_shipments
    WHERE account_id=${accountId}::uuid AND id=${shipmentId}::uuid`)[0] ?? null);
  if (!row || row.claimed) return 'skipped';
  const secrets = await loadCourierSecrets(accountId);
  if (!secrets || secrets.status !== 'active' || secrets.connectionId !== row.connection_id) return 'skipped';
  const createAmbiguous = row.create_state === 'unknown' || (row.create_state === 'creating' && row.claim_token !== null);
  const awbAmbiguous = row.create_state === 'created' && (row.awb_state === 'unknown' || (row.awb_state === 'assigning' && row.claim_token !== null));
  if (!createAmbiguous && !awbAmbiguous) return 'skipped';

  let found: FoundOrder | null;
  try {
    found = createAmbiguous
      ? findByReference(await shiprocketCall(accountId, 'GET', `/orders?search=${encodeURIComponent(row.reference)}`), row.reference)
      : row.sr_order_id ? parseOrderShow(await shiprocketCall(accountId, 'GET', `/orders/show/${row.sr_order_id}`), row.sr_order_id) : null;
  } catch (error) {
    // No HTTP happened (switched off or disconnected meanwhile).
    if (error instanceof ShipmentError) return 'skipped';
    if (error instanceof ShiprocketError) {
      console.error('[shipments] reconcile lookup failed', { shipmentId, kind: error.kind });
      return 'unknown';
    }
    throw error;
  }

  const unclaimed = Prisma.sql`account_id=${accountId}::uuid AND id=${shipmentId}::uuid AND (claimed_until IS NULL OR claimed_until <= now())`;
  let adoptedAwb: string | null = null;
  const outcome = await asWorker(accountId, async (tx) => {
    await lockOrderRow(tx, accountId, row.order_id);
    const current = await lockShipment(tx, accountId, shipmentId);
    if (!current || current.claimed) return 'skipped' as const;
    if (createAmbiguous) {
      if (current.create_state !== 'unknown' && current.create_state !== 'creating') return 'skipped' as const;
      if (!found || !found.srShipmentId) {
        await tx.$executeRaw`UPDATE order_shipments SET create_state='unknown', claim_token=NULL, claimed_until=NULL WHERE ${unclaimed}`;
        if (opts.openException) await openShipmentException(tx, accountId, shipmentId, 'create_unknown');
        return 'unknown' as const;
      }
      await tx.$executeRaw`UPDATE order_shipments SET create_state='created', sr_order_id=${found.srOrderId},
          sr_shipment_id=${found.srShipmentId}, claim_token=NULL, claimed_until=NULL, last_error_code=NULL WHERE ${unclaimed}`;
      if (found.awb) {
        await recordAwb(tx, accountId, shipmentId, found.awb, found.courier, unclaimed);
        adoptedAwb = found.srShipmentId;
      }
      return 'adopted' as const;
    }
    if (current.awb_state !== 'unknown' && current.awb_state !== 'assigning') return 'skipped' as const;
    if (found?.awb) {
      await recordAwb(tx, accountId, shipmentId, found.awb, found.courier, unclaimed);
      adoptedAwb = current.sr_shipment_id;
      return 'adopted' as const;
    }
    // Never assign again: the first assignment may have charged the wallet. Staff resolve the exception.
    await tx.$executeRaw`UPDATE order_shipments SET awb_state='unknown', claim_token=NULL, claimed_until=NULL WHERE ${unclaimed}`;
    if (opts.openException) await openShipmentException(tx, accountId, shipmentId, 'awb_unknown');
    return 'unknown' as const;
  });
  if (adoptedAwb) await requestPickup(accountId, shipmentId, adoptedAwb);
  return outcome;
}

// ---------------------------------------------------------------- read

interface ViewRow {
  id: string;
  order_id: string;
  reference: string;
  create_state: ShipmentCreateState;
  awb_state: ShipmentAwbState;
  awb: string | null;
  courier_name: string | null;
  tracking_status: TrackingStatus | null;
  tracking_rank: number | null;
  tracking_event_at: Date | null;
  provider_dispatched_at: Date | null;
  provider_delivered_at: Date | null;
  last_error_code: string | null;
  length_cm: Prisma.Decimal | number;
  breadth_cm: Prisma.Decimal | number;
  height_cm: Prisma.Decimal | number;
  weight_grams: number;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** The order's live shipment, else its latest one, as the app may see it (null when none or for a viewer). */
export async function getOrderShipment(tx: TenantTransaction, accountId: string, orderId: string): Promise<OrderShipmentView | null> {
  const [row] = await tx.$queryRaw<ViewRow[]>`SELECT id::text AS id, order_id::text AS order_id, reference, create_state, awb_state, awb,
      courier_name, tracking_status, tracking_rank, tracking_event_at, provider_dispatched_at, provider_delivered_at, last_error_code,
      length_cm, breadth_cm, height_cm, weight_grams, created_at
    FROM order_shipments WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid
    ORDER BY (create_state NOT IN ('failed','cancelled')) DESC, created_at DESC LIMIT 1`;
  if (!row) return null;
  return {
    id: row.id, order_id: row.order_id, reference: row.reference, create_state: row.create_state, awb_state: row.awb_state,
    awb: row.awb, courier_name: row.courier_name, tracking_status: row.tracking_status, tracking_rank: row.tracking_rank,
    tracking_event_at: iso(row.tracking_event_at), provider_dispatched_at: iso(row.provider_dispatched_at),
    provider_delivered_at: iso(row.provider_delivered_at), last_error_code: row.last_error_code,
    length_cm: Number(row.length_cm), breadth_cm: Number(row.breadth_cm), height_cm: Number(row.height_cm),
    weight_grams: row.weight_grams, created_at: new Date(row.created_at).toISOString(),
  };
}

/** Sweep helper: re-queues the create job of a shipment that was never sent (claim_token NULL). */
export async function requeueUnsentShipment(accountId: string, shipmentId: string): Promise<void> {
  await asWorker(accountId, (tx) => enqueueCreateJob(tx, accountId, shipmentId));
}
