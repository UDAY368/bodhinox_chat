/**
 * Edit an order before it is dispatched (Store Phase 5). Agents and above with
 * commerce.checkout (as creating a manual order); an edit that refunds money
 * also needs commerce.refunds.
 *
 * One transaction as the signed-in member on the worker connection. Lock order:
 * customer_payments rows -> order row -> coupon -> inventory rows (ascending).
 * - The editor sends the full new set of lines and the edit_version it read; a
 *   stale version is a 409 conflict. The edit id is derived from (workspace,
 *   member, client_request_id): a replay returns the edit it already made and
 *   never moves stock, refunds or links twice.
 * - Only a priced order that is confirmed, paid or partially shipped, with no
 *   open payment link and no refund in flight. A line never goes below what a
 *   live shipment already carries.
 * - The server reprices with the same pipeline as checkout (priceCart: automatic
 *   discounts, the order's coupon, zone and weight shipping, tax). Lines already
 *   on the order keep the unit price and tax rate the customer agreed to; added
 *   lines take today's catalogue price. Nothing from the browser is a price.
 * - Stock follows in the same transaction (stock.adjustOrderStockTx): an unpaid
 *   order's hold, or a paid order's sold units. Not enough stock refuses the edit.
 * - The payment difference is never absorbed. Nothing paid yet (unpaid online or
 *   cash on delivery): the total changes and the admin sees the new amount.
 *   Paid and now higher: a Razorpay payment link for the difference is created
 *   after commit (reference derived from the edit id) and the order shows the
 *   balance due; it is not sent, staff copy it or send it through payment links.
 *   Paid and now lower: gateway refunds are written row-first in this
 *   transaction (ids derived from the edit id; lib/payments/refunds sends them
 *   once and surfaces an unclear outcome for reconciliation), and money Razorpay
 *   does not hold needs the member's confirmation that it was returned outside.
 * - An issued GST tax invoice is never changed: a decrease that refunds gets its
 *   credit note from the refund path; every other edit is refused (invoice_issued).
 * - order_edits keeps the lines and totals before and after, who and why; the
 *   order history gets an 'order_edited' event and the audit log ids and amounts.
 *
 * Logs and audit metadata carry ids, codes and amounts only.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { orderLinesShipped } from '@/lib/fulfilment/shipments';
import { orderEventTx, stableUuid } from '@/lib/payments/ledger';
import { createPaymentLinkRecord, LIVE_LINK_STATUSES, PaymentLinkError, selectLink } from '@/lib/payments/links';
import { applyRefundStateTx, requestEditRefundTx } from '@/lib/payments/refunds';
import { loadAutoDiscountsTx } from './auto-discount-rules';
import { lockCouponTx, toPricingCoupon } from './coupons';
import { minorFromDb } from './money';
import {
  allocateRefund, diffOrderLines, EDITABLE_STATUSES, paymentDifference, type DesiredLine, type LineChange, type PaymentAction,
} from './order-edit-plan';
import { BALANCE_LINK_ATTEMPTS, editBalanceReference } from './order-edit-reference';
import { asStaff, assertStaff, auditOrder, lockSettledPayments, viaGateway, type SettledPayment, type StaffContext } from './order-lifecycle';
import { CART_LIMITS, priceCart, type PricingRefusal, type PricingVariant, type Quote } from './pricing';
import { adjustOrderStockTx, StockError } from './stock';
import { loadVariants, orderReference } from './storefront';
import { loadPricingSettings, pricingRate, selectRates } from './store-settings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EDIT_REASON_MAX = 500;

export type OrderEditErrorCode =
  | 'invalid' | 'not_found' | 'conflict' | 'not_editable' | 'no_change' | 'cart_empty' | 'below_shipped' | 'out_of_stock'
  | 'payment_link_open' | 'refund_in_flight' | 'invoice_issued' | 'offline_payment' | 'amount_exceeds' | 'cod_shipment_live'
  | 'store_not_configured' | 'store_changed' | PricingRefusal;

const STATUS: Partial<Record<OrderEditErrorCode, number>> = { invalid: 400, not_found: 404 };

export class OrderEditError extends Error {
  readonly status: number;
  constructor(readonly code: OrderEditErrorCode, readonly variantId?: string) {
    super(code);
    this.name = 'OrderEditError';
    this.status = STATUS[code] ?? 409;
  }
}

export interface OrderEditInput {
  expectedVersion: number;
  lines: DesiredLine[];
  reason: string;
  clientRequestId: string;
  /** The member confirms that money Razorpay does not hold (cash, a recorded payment) was returned outside the app. */
  refundedOutside: boolean;
}

/** Validate { expected_version, lines: [{ variant_id, qty }], reason, client_request_id, refunded_outside? }. Prices are never accepted. */
export function parseOrderEdit(body: unknown): OrderEditInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OrderEditError('invalid');
  const b = body as Record<string, unknown>;
  const allowed = new Set(['expected_version', 'lines', 'reason', 'client_request_id', 'refunded_outside', 'preview']);
  if (Object.keys(b).some((k) => !allowed.has(k))) throw new OrderEditError('invalid');
  if (typeof b.expected_version !== 'number' || !Number.isInteger(b.expected_version) || b.expected_version < 0) throw new OrderEditError('invalid');
  if (typeof b.client_request_id !== 'string' || !UUID.test(b.client_request_id)) throw new OrderEditError('invalid');
  if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.trim().length > EDIT_REASON_MAX) throw new OrderEditError('invalid');
  if (b.refunded_outside !== undefined && typeof b.refunded_outside !== 'boolean') throw new OrderEditError('invalid');
  if (!Array.isArray(b.lines) || b.lines.length > CART_LIMITS.maxLines) throw new OrderEditError('invalid');
  const lines: DesiredLine[] = [];
  for (const raw of b.lines as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OrderEditError('invalid');
    const line = raw as Record<string, unknown>;
    if (Object.keys(line).some((k) => k !== 'variant_id' && k !== 'qty')) throw new OrderEditError('invalid');
    if (typeof line.variant_id !== 'string' || !UUID.test(line.variant_id)) throw new OrderEditError('invalid');
    if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > CART_LIMITS.maxQty) throw new OrderEditError('invalid');
    lines.push({ variantId: line.variant_id.toLowerCase(), qty: line.qty });
  }
  return {
    expectedVersion: b.expected_version, lines, reason: b.reason.trim(), clientRequestId: b.client_request_id.toLowerCase(),
    refundedOutside: b.refunded_outside === true,
  };
}

export interface EditTotals {
  subtotal_minor: number;
  discount_minor: number;
  shipping_minor: number;
  cod_fee_minor: number;
  tax_minor: number;
  total_minor: number;
}

export interface EditLineSnapshot {
  variant_id: string | null;
  sku: string | null;
  name: string | null;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number | null;
}

export interface OrderEditPreview {
  version: number;
  currency: string;
  before: EditTotals;
  after: EditTotals;
  lines: EditLineSnapshot[];
  payment: {
    action: PaymentAction;
    difference_minor: number;
    /** Part of the refund is money Razorpay does not hold: the member must confirm it was returned outside. */
    needs_outside_confirmation: boolean;
  };
}

export type EditPaymentState = 'none' | 'link_pending' | 'link_created' | 'link_failed' | 'link_unknown' | 'link_paid' | 'refund_requested' | 'refund_outside';

export interface OrderEditView {
  id: string;
  reason: string;
  actor_name: string | null;
  total_before_minor: number;
  total_after_minor: number;
  payment_action: PaymentAction;
  difference_minor: number;
  payment_state: EditPaymentState;
  failure_code: string | null;
  /** The balance link to copy to the customer (only while it can still be paid). */
  payment_link_url: string | null;
  lines_before: EditLineSnapshot[];
  lines_after: EditLineSnapshot[];
  created_at: string;
}

interface OrderRow {
  id: string;
  status: string;
  source: string;
  priced_at: Date | null;
  currency: string;
  payment_method: string;
  paid_at: Date | null;
  coupon_code: string | null;
  shipping_address: unknown;
  tax_inclusive: boolean | null;
  subtotal_minor: bigint | number;
  discount_minor: bigint | number;
  shipping_minor: bigint | number;
  cod_fee_minor: bigint | number;
  tax_minor: bigint | number;
  total_minor: bigint | number | null;
  refund_state: string | null;
  edit_version: number;
  contact_id: string | null;
  conversation_id: string | null;
}

interface ItemRow {
  id: string;
  variant_id: string | null;
  name: string | null;
  sku: string | null;
  hsn_code: string | null;
  quantity: number;
  unit_price_minor: bigint | number;
  tax_rate_bps: number | null;
  line_total_minor: bigint | number | null;
  shipped: number;
}

const ORDER_COLUMNS = `id::text AS id, status, source, priced_at, currency, payment_method, paid_at, coupon_code, shipping_address, tax_inclusive,
  subtotal_minor, discount_minor, shipping_minor, cod_fee_minor, tax_minor, total_minor, refund_state, edit_version,
  contact_id::text AS contact_id, conversation_id::text AS conversation_id`;

const totalsOf = (o: Pick<OrderRow, 'subtotal_minor' | 'discount_minor' | 'shipping_minor' | 'cod_fee_minor' | 'tax_minor' | 'total_minor'>): EditTotals => ({
  subtotal_minor: minorFromDb(o.subtotal_minor) ?? 0, discount_minor: minorFromDb(o.discount_minor) ?? 0,
  shipping_minor: minorFromDb(o.shipping_minor) ?? 0, cod_fee_minor: minorFromDb(o.cod_fee_minor) ?? 0,
  tax_minor: minorFromDb(o.tax_minor) ?? 0, total_minor: minorFromDb(o.total_minor) ?? 0,
});

const quoteTotals = (q: Quote): EditTotals => ({
  subtotal_minor: q.subtotalMinor, discount_minor: q.discountMinor, shipping_minor: q.shippingMinor, cod_fee_minor: q.codFeeMinor,
  tax_minor: q.taxMinor, total_minor: q.totalMinor,
});

const lineName = (l: Quote['lines'][number]): string => {
  const options = Object.values(l.optionValues).filter(Boolean).join(' / ');
  return (options ? `${l.productName} (${options})` : l.productName).slice(0, 500);
};

const snapshot = (i: ItemRow): EditLineSnapshot => ({
  variant_id: i.variant_id, sku: i.sku, name: i.name, quantity: i.quantity, unit_price_minor: minorFromDb(i.unit_price_minor) ?? 0,
  line_total_minor: minorFromDb(i.line_total_minor),
});

/** What the lines cost on top of the goods (shipping, COD fee and their tax): a courier collects it with the first parcel. */
const extrasOf = (totalMinor: number, lineTotals: Array<number | null>): number => totalMinor - lineTotals.reduce<number>((n, v) => n + (v ?? 0), 0);

/**
 * An order the edit cannot reprice (store plan Phase 8): the edit prices like a plain shipped cart, so it
 * would charge a shipping rate on a pickup or local delivery order, lose a discount rule or a free gift,
 * and measure the balance without the store credit and points already spent. Bundles, pre-orders and
 * digital products hold stock and ship differently too. Such an order is refused rather than repriced wrongly.
 */
async function beyondEditTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ blocked: boolean }[]>`
    SELECT (o.delivery_method <> 'ship' OR o.store_credit_minor > 0 OR o.points_redeemed > 0
      OR COALESCE(o.discount_details @> '[{"kind":"price_rule"}]'::jsonb, false)
      OR EXISTS (SELECT 1 FROM order_items i
          LEFT JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
          LEFT JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
        WHERE i.account_id=o.account_id AND i.order_id=o.id
          AND (i.is_gift OR i.bundle_parts IS NOT NULL OR i.preorder_ship_date IS NOT NULL OR COALESCE(p.is_digital OR p.is_bundle, false)))) AS blocked
    FROM orders o WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
  return row?.blocked === true;
}

interface Plan {
  order: OrderRow;
  items: ItemRow[];
  changes: LineChange[];
  quote: Quote;
  settled: SettledPayment[];
  action: PaymentAction;
  differenceMinor: number;
  refundParts: Array<{ paymentId: string; amountMinor: number; gateway: boolean }>;
}

/** Everything an edit needs, decided under the payment and order locks. Throws OrderEditError; writes nothing. */
async function planEditTx(tx: TenantTransaction, ctx: StaffContext, orderId: string, input: Pick<OrderEditInput, 'expectedVersion' | 'lines'>): Promise<Plan> {
  const settled = await lockSettledPayments(tx, ctx.accountId, orderId);
  const [order] = await tx.$queryRawUnsafe<OrderRow[]>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE`, ctx.accountId, orderId);
  if (!order) throw new OrderEditError('not_found');
  if (order.edit_version !== input.expectedVersion) throw new OrderEditError('conflict');
  if (!order.priced_at || order.source === 'shopify' || order.source === 'woocommerce' || !EDITABLE_STATUSES.includes(order.status)
    || order.refund_state === 'full') throw new OrderEditError('not_editable');
  if (await beyondEditTx(tx, ctx.accountId, orderId)) throw new OrderEditError('not_editable');
  // Paid before payments were recorded per payment: there is nothing to refund against or to measure a balance from.
  if (order.paid_at && !settled.length) throw new OrderEditError('not_editable');
  const [inFlight] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_refunds
    WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND status IN ('requested','sending','pending','unknown')`;
  if ((inFlight?.n ?? 0) > 0) throw new OrderEditError('refund_in_flight');
  // A link that can still take (or already took, unseen) the old amount: staff cancel it first.
  const [link] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM payment_links
    WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND status = ANY(${[...LIVE_LINK_STATUSES]}::text[]) LIMIT 1`;
  if (link) throw new OrderEditError('payment_link_open');

  const items = (await orderLinesShipped(tx, ctx.accountId, orderId)) as ItemRow[];
  const diff = diffOrderLines(items.map((i) => ({ id: i.id, variantId: i.variant_id, quantity: i.quantity, shipped: i.shipped })), input.lines);
  if (!diff.ok) throw new OrderEditError(diff.code, diff.variantId);
  // A line added by the edit cannot be a bundle, a pre-order or a digital product (see beyondEditTx).
  const onOrder = new Set(items.map((i) => i.variant_id));
  const addedIds = diff.lines.map((l) => l.variantId).filter((id) => !onOrder.has(id));
  if (addedIds.length) {
    const [special] = await tx.$queryRaw<{ id: string }[]>`SELECT v.id::text AS id FROM shop_variants v
      JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      WHERE v.account_id=${ctx.accountId}::uuid AND v.id = ANY(${addedIds}::uuid[]) AND (p.is_digital OR p.is_bundle OR v.preorder) LIMIT 1`;
    if (special) throw new OrderEditError('variant_unavailable', special.id);
  }

  const settings = await loadPricingSettings(tx, ctx.accountId);
  if (!settings) throw new OrderEditError('store_not_configured');
  // The currency and the tax mode of a priced order are frozen: a store that changed either cannot reprice it.
  if (settings.currency !== order.currency || (order.tax_inclusive !== null && settings.pricesIncludeTax !== order.tax_inclusive))
    throw new OrderEditError('store_changed');
  const cod = order.payment_method === 'cod';
  const loaded = await loadVariants(tx, ctx.accountId, diff.lines.map((l) => l.variantId));
  const variants = new Map<string, PricingVariant>(loaded);
  for (const item of items) {
    if (!item.variant_id) continue;
    const current = loaded.get(item.variant_id);
    // A line already on the order keeps what the customer agreed to, whatever the catalogue says today.
    variants.set(item.variant_id, {
      id: item.variant_id, productId: current?.productId ?? '', productName: item.name ?? current?.productName ?? '',
      sku: item.sku ?? current?.sku ?? '', optionValues: {}, priceMinor: minorFromDb(item.unit_price_minor),
      taxRateBps: item.tax_rate_bps ?? current?.taxRateBps ?? null, hsnCode: item.hsn_code, trackInventory: current?.trackInventory ?? false,
      sellable: true, codAvailable: true, weightGrams: current?.weightGrams ?? null,
    });
  }
  const address = order.shipping_address && typeof order.shipping_address === 'object' && !Array.isArray(order.shipping_address)
    ? order.shipping_address as { country?: unknown; postal_code?: unknown; state?: unknown; state_code?: unknown } : null;
  const pricingAddress = address && typeof address.country === 'string' && typeof address.postal_code === 'string'
    ? { country: address.country, postalCode: address.postal_code, state: typeof address.state === 'string' ? address.state : null,
      stateCode: typeof address.state_code === 'string' ? address.state_code : null } : null;
  const coupon = order.coupon_code ? await lockCouponTx(tx, ctx.accountId, order.coupon_code) : null;
  const priced = priceCart({
    lines: diff.lines, variants, settings: { ...settings, codEnabled: cod ? true : settings.codEnabled },
    shippingRates: pricingAddress ? (await selectRates(tx, ctx.accountId, true)).map(pricingRate) : [],
    // The order already redeemed its coupon: it stays applied even if it was switched off since.
    coupon: order.coupon_code ? (coupon ? { ...toPricingCoupon(coupon), active: true } : 'missing') : null,
    address: pricingAddress, paymentMethod: cod ? 'cod' : 'online',
    autoDiscounts: await loadAutoDiscountsTx(tx, ctx.accountId), now: order.priced_at,
  });
  if (!priced.ok) throw new OrderEditError(priced.code, priced.variantId);
  const quote = priced.quote;

  const paidNet = settled.reduce((n, p) => n + Math.max(0, minorFromDb(p.refundable) ?? 0), 0);
  const { action, differenceMinor } = paymentDifference({ paidNetMinor: paidNet, totalAfterMinor: quote.totalMinor });

  const [invoice] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM commerce_documents
    WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid AND kind='tax_invoice' LIMIT 1`;
  // An issued tax invoice is never changed. Only a decrease that refunds is documented (the refund's credit note).
  if (invoice && action !== 'refund') throw new OrderEditError('invoice_issued');

  // An unpaid COD parcel already with the courier collects its goods plus the order's extras: those must not move.
  if (cod && !order.paid_at && items.some((i) => i.shipped > 0)
    && extrasOf(quote.totalMinor, quote.lines.map((l) => l.lineTotalMinor)) !== extrasOf(minorFromDb(order.total_minor) ?? 0, items.map((i) => minorFromDb(i.line_total_minor))))
    throw new OrderEditError('cod_shipment_live');

  let refundParts: Plan['refundParts'] = [];
  if (action === 'refund') {
    const allocation = allocateRefund(
      settled.map((p) => ({ id: p.id, refundableMinor: minorFromDb(p.refundable) ?? 0, gateway: viaGateway(p) })), differenceMinor);
    if (!allocation.ok) throw new OrderEditError('amount_exceeds');
    refundParts = allocation.parts;
  }
  return { order, items, changes: diff.changes, quote, settled, action, differenceMinor, refundParts };
}

const previewOf = (plan: Plan): OrderEditPreview => ({
  version: plan.order.edit_version, currency: plan.order.currency, before: totalsOf(plan.order), after: quoteTotals(plan.quote),
  lines: plan.quote.lines.map((l) => ({
    variant_id: l.variantId, sku: l.sku, name: lineName(l), quantity: l.qty, unit_price_minor: l.unitPriceMinor, line_total_minor: l.lineTotalMinor,
  })),
  payment: { action: plan.action, difference_minor: plan.differenceMinor, needs_outside_confirmation: plan.refundParts.some((p) => !p.gateway) },
});

function check(ctx: StaffContext, orderId: string): void {
  assertStaff(ctx);
  if (!UUID.test(orderId)) throw new OrderEditError('not_found');
}

/** The new totals and the payment difference of an edit, before anything is saved. Writes nothing. */
export async function previewOrderEdit(ctx: StaffContext, orderId: string, input: Pick<OrderEditInput, 'expectedVersion' | 'lines'>): Promise<OrderEditPreview> {
  check(ctx, orderId);
  await requirePermission(ctx, 'commerce.checkout');
  return asStaff(ctx, async (tx) => previewOf(await planEditTx(tx, ctx, orderId, input)));
}

export const orderEditId = (accountId: string, userId: string, clientRequestId: string): string =>
  stableUuid(`order-edit:${accountId}:${userId}:${clientRequestId}`);

/**
 * Save an edit (see the module comment). Returns the edit id and whether this
 * call made it (false for a replay). A balance link, when one is due, is
 * created after the commit; its outcome is on the edit (getOrderEditState).
 */
export async function editOrder(ctx: StaffContext, orderId: string, input: OrderEditInput): Promise<{ editId: string; created: boolean; payment_action: PaymentAction }> {
  check(ctx, orderId);
  await requirePermission(ctx, 'commerce.checkout');
  const editId = orderEditId(ctx.accountId, ctx.userId, input.clientRequestId);
  let result: { editId: string; created: boolean; payment_action: PaymentAction };
  try {
    result = await asStaff(ctx, async (tx) => {
      const [replay] = await tx.$queryRaw<{ order_id: string; payment_action: PaymentAction }[]>`
        SELECT order_id::text AS order_id, payment_action FROM order_edits WHERE account_id=${ctx.accountId}::uuid AND id=${editId}::uuid`;
      if (replay) {
        if (replay.order_id !== orderId.toLowerCase()) throw new OrderEditError('invalid');
        return { editId, created: false, payment_action: replay.payment_action };
      }
      const plan = await planEditTx(tx, ctx, orderId, input);
      if (plan.action === 'refund') {
        await requirePermission(ctx, 'commerce.refunds');
        if (plan.refundParts.some((p) => !p.gateway) && !input.refundedOutside) throw new OrderEditError('offline_payment');
      }
      const { order, quote } = plan;
      // The priced freeze lets this one transaction change this one order (orders_priced_freeze, order_items_priced_freeze).
      await tx.$queryRaw`SELECT set_config('app.order_edit', ${order.id}, true)`;

      await adjustOrderStockTx(tx, ctx.accountId, order.id, plan.changes.map((c) => ({ variantId: c.variantId, delta: c.delta })),
        { committed: order.paid_at !== null, actorUserId: ctx.userId });

      const byVariant = new Map(plan.items.map((i) => [i.variant_id, i]));
      const kept = new Set<string>();
      for (const line of quote.lines) {
        const item = byVariant.get(line.variantId);
        if (item) {
          kept.add(item.id);
          await tx.$executeRaw`UPDATE order_items SET quantity=${line.qty}, tax_minor=${line.taxMinor}, discount_minor=${line.discountMinor},
              line_total_minor=${line.lineTotalMinor}
            WHERE account_id=${ctx.accountId}::uuid AND id=${item.id}::uuid`;
        } else {
          await tx.$executeRaw`INSERT INTO order_items(account_id,order_id,retailer_id,name,quantity,unit_price_minor,currency,variant_id,
              tax_rate_bps,tax_minor,discount_minor,line_total_minor,hsn_code,sku)
            VALUES(${ctx.accountId}::uuid,${order.id}::uuid,${line.sku},${lineName(line)},${line.qty},${line.unitPriceMinor},${quote.currency},
              ${line.variantId}::uuid,${line.taxRateBps},${line.taxMinor},${line.discountMinor},${line.lineTotalMinor},${line.hsnCode},${line.sku})`;
        }
      }
      const removed = plan.items.filter((i) => !kept.has(i.id)).map((i) => i.id);
      if (removed.length) await tx.$executeRaw`DELETE FROM order_items WHERE account_id=${ctx.accountId}::uuid AND order_id=${order.id}::uuid
        AND id = ANY(${removed}::uuid[])`;

      const discountDetails = quote.autoDiscounts.length
        ? JSON.stringify(quote.autoDiscounts.map((d) => ({ name: d.name, kind: d.kind, saving_minor: d.savingMinor }))) : null;
      const versionAfter = order.edit_version + 1;
      const moved = await tx.$executeRaw`UPDATE orders SET subtotal_minor=${quote.subtotalMinor}, discount_minor=${quote.discountMinor},
          shipping_minor=${quote.shippingMinor}, tax_minor=${quote.taxMinor}, total_minor=${quote.totalMinor}, cod_fee_minor=${quote.codFeeMinor},
          auto_discount_minor=${quote.autoDiscountMinor}, discount_details=${discountDetails}::jsonb, edit_version=${versionAfter}, updated_at=now()
        WHERE account_id=${ctx.accountId}::uuid AND id=${order.id}::uuid AND edit_version=${order.edit_version}`;
      if (moved !== 1) throw new OrderEditError('conflict');

      const note = `Order edit: ${input.reason}`.slice(0, 500);
      const refundIds: string[] = [];
      for (const part of plan.refundParts) {
        const payment = plan.settled.find((p) => p.id === part.paymentId)!;
        const refundId = stableUuid(`order-edit-refund:${editId}:${payment.id}`);
        if (part.gateway) {
          await requestEditRefundTx(tx, ctx, { refundId, payment, amountMinor: part.amountMinor, note });
        } else {
          // Money Razorpay does not hold, confirmed as returned outside: recorded as refunded at once (as Cancel and refund).
          await tx.$executeRaw`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,
              reason_code,note,status,attempt,requested_by,restock)
            VALUES(${refundId}::uuid,${ctx.accountId}::uuid,${payment.id}::uuid,${order.id}::uuid,'external',${BigInt(part.amountMinor)},${payment.currency},
              'other',${note},'pending',1,${ctx.userId}::uuid,false)`;
          await applyRefundStateTx(tx, ctx.accountId, payment, refundId, 'processed', null);
        }
        refundIds.push(refundId);
      }
      const state: EditPaymentState = plan.action === 'collect' ? 'link_pending'
        : plan.action === 'refund' ? (plan.refundParts.some((p) => p.gateway) ? 'refund_requested' : 'refund_outside') : 'none';
      const before = totalsOf(order);
      const after = quoteTotals(quote);
      const linesAfter = previewOf(plan).lines;
      await tx.$executeRaw`INSERT INTO order_edits(id,account_id,order_id,actor_user_id,reason,lines_before,lines_after,totals_before,totals_after,
          total_before_minor,total_after_minor,payment_action,difference_minor,payment_state,refund_ids,version_after)
        VALUES(${editId}::uuid,${ctx.accountId}::uuid,${order.id}::uuid,${ctx.userId}::uuid,${input.reason},
          ${JSON.stringify(plan.items.map(snapshot))}::jsonb,${JSON.stringify(linesAfter)}::jsonb,${JSON.stringify(before)}::jsonb,
          ${JSON.stringify(after)}::jsonb,${before.total_minor},${after.total_minor},${plan.action},${plan.differenceMinor},${state},
          ${refundIds}::uuid[],${versionAfter})`;
      await orderEventTx(tx, ctx.accountId, order.id, 'order_edited', { actorUserId: ctx.userId, detail: plan.action });
      await auditOrder(tx, ctx, 'order.edited', order.id, {
        edit_id: editId, lines_changed: plan.changes.length, total_before_minor: before.total_minor, total_after_minor: after.total_minor,
        payment_action: plan.action, difference_minor: plan.differenceMinor, refunds: refundIds.length,
      });
      return { editId, created: true, payment_action: plan.action };
    });
  } catch (error) {
    if (error instanceof StockError && error.code === 'out_of_stock') throw new OrderEditError('out_of_stock', error.variantId);
    throw error;
  }
  // The edit is saved either way: a link that could not be made is shown on the order with its reason, and can be asked for again.
  if (result.payment_action === 'collect') await ensureBalanceLink(ctx, orderId, editId).catch((error) => {
    console.error('[order-edits] balance link failed', { editId, code: error instanceof OrderEditError ? error.code : 'error' });
  });
  return result;
}

const worker = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

/**
 * Create (or find) the Razorpay link for the balance of the order's latest
 * edit. Safe to call again: the reference is derived from the edit id, so a
 * replay returns the same link; a new attempt's reference is used only after
 * Razorpay definitely refused the previous one. Nothing is sent to the
 * customer. The outcome is stored on the edit.
 */
export async function ensureBalanceLink(ctx: StaffContext, orderId: string, editId: string): Promise<EditPaymentState> {
  check(ctx, orderId);
  await requirePermission(ctx, 'commerce.checkout');
  if (!UUID.test(editId)) throw new OrderEditError('not_found');
  const plan = await worker(ctx.accountId, async (tx) => {
    const [edit] = await tx.$queryRaw<{ id: string; payment_action: string; payment_state: EditPaymentState; difference_minor: bigint | number;
      latest: boolean; currency: string; status: string; contact_id: string | null; conversation_id: string | null }[]>`
      SELECT e.id::text AS id, e.payment_action, e.payment_state, e.difference_minor, o.currency, o.status,
        o.contact_id::text AS contact_id, o.conversation_id::text AS conversation_id,
        NOT EXISTS (SELECT 1 FROM order_edits n WHERE n.account_id=e.account_id AND n.order_id=e.order_id AND n.version_after > e.version_after) AS latest
      FROM order_edits e JOIN orders o ON o.account_id=e.account_id AND o.id=e.order_id
      WHERE e.account_id=${ctx.accountId}::uuid AND e.id=${editId}::uuid AND e.order_id=${orderId}::uuid`;
    if (!edit || edit.payment_action !== 'collect') throw new OrderEditError('not_found');
    if (edit.payment_state === 'link_paid') return { done: 'link_paid' as const };
    // A later edit measured the balance again, and a cancelled order owes nothing.
    if (!edit.latest || edit.status === 'cancelled') throw new OrderEditError('conflict');
    let reference = editBalanceReference(editId, BALANCE_LINK_ATTEMPTS);
    for (let attempt = 1; attempt <= BALANCE_LINK_ATTEMPTS; attempt += 1) {
      reference = editBalanceReference(editId, attempt);
      const row = await selectLink(tx, ctx.accountId, { referenceId: reference });
      if (!row || row.status !== 'failed') break;
    }
    return { done: null, reference, amount: minorFromDb(edit.difference_minor) ?? 0, currency: edit.currency,
      contactId: edit.contact_id, conversationId: edit.conversation_id };
  });
  if (plan.done) return plan.done;

  let state: EditPaymentState;
  let linkId: string | null = null;
  let failure: string | null = null;
  try {
    const { link, outcome, reason } = await createPaymentLinkRecord({
      accountId: ctx.accountId, actor: { kind: 'bot' }, amountMinor: plan.amount, currency: plan.currency,
      description: getT('Commerce.orderEdit')('balanceLinkDescription', { reference: orderReference(orderId) }),
      contactId: plan.contactId, conversationId: plan.conversationId, orderId, referenceId: plan.reference,
    });
    linkId = link.id;
    if (outcome === 'rejected' || link.status === 'failed' || link.status === 'cancelled' || link.status === 'expired') {
      state = 'link_failed';
      failure = reason && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : link.status === 'failed' ? 'provider_rejected' : link.status;
    } else if (outcome === 'unknown' || link.status === 'unknown' || link.status === 'creating') state = 'link_unknown';
    else state = 'link_created';
  } catch (error) {
    if (!(error instanceof PaymentLinkError)) throw error;
    state = 'link_failed';
    failure = error.code;
  }
  await worker(ctx.accountId, (tx) => tx.$executeRaw`UPDATE order_edits SET payment_state=${state}, payment_link_id=COALESCE(${linkId}::uuid, payment_link_id),
      failure_code=${failure}
    WHERE account_id=${ctx.accountId}::uuid AND id=${editId}::uuid AND payment_state<>'link_paid'`);
  return state;
}

export interface OrderEditState {
  version: number;
  /** Null when the order can be edited; otherwise why not (a code the UI translates). */
  blocked: 'not_editable' | 'payment_link_open' | 'refund_in_flight' | null;
  currency: string;
  lines: Array<{ id: string; variant_id: string | null; name: string | null; sku: string | null; quantity: number; shipped: number; unit_price_minor: number }>;
  /** What the customer still owes after an edit raised a paid order's total (0 when nothing). */
  balance_due_minor: number;
  edits: OrderEditView[];
}

/** The order's edit version, its lines with shipped quantities, the edits so far and any balance due. Caller's session (app role). */
export async function getOrderEditState(ctx: TenantContext, orderId: string): Promise<OrderEditState> {
  if (!UUID.test(orderId)) throw new OrderEditError('not_found');
  return withTenant(ctx, async (tx) => {
    const [order] = await tx.$queryRawUnsafe<OrderRow[]>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id=$1::uuid AND id=$2::uuid`, ctx.accountId, orderId);
    if (!order) throw new OrderEditError('not_found');
    const items = (await orderLinesShipped(tx, ctx.accountId, orderId)) as ItemRow[];
    const edits = await tx.$queryRaw<{ id: string; reason: string; actor_name: string | null; total_before_minor: bigint; total_after_minor: bigint;
      payment_action: PaymentAction; difference_minor: bigint; payment_state: EditPaymentState; failure_code: string | null;
      link_url: string | null; link_status: string | null; lines_before: unknown; lines_after: unknown; created_at: Date }[]>`
      SELECT e.id::text AS id, e.reason, (SELECT p.full_name FROM profiles p WHERE p.user_id=e.actor_user_id LIMIT 1) AS actor_name,
        e.total_before_minor, e.total_after_minor, e.payment_action, e.difference_minor, e.payment_state, e.failure_code,
        l.short_url AS link_url, l.status AS link_status, e.lines_before, e.lines_after, e.created_at
      FROM order_edits e LEFT JOIN payment_links l ON l.account_id=e.account_id AND l.id=e.payment_link_id
      WHERE e.account_id=${ctx.accountId}::uuid AND e.order_id=${orderId}::uuid ORDER BY e.version_after DESC LIMIT 50`;
    const [flags] = await tx.$queryRaw<{ link: boolean; refund: boolean }[]>`SELECT
      EXISTS (SELECT 1 FROM payment_links WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid
        AND status = ANY(${[...LIVE_LINK_STATUSES]}::text[])) AS link,
      EXISTS (SELECT 1 FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND order_id=${orderId}::uuid
        AND status IN ('requested','sending','pending','unknown')) AS refund`;
    const editable = Boolean(order.priced_at) && order.source !== 'shopify' && order.source !== 'woocommerce'
      && EDITABLE_STATUSES.includes(order.status) && order.refund_state !== 'full' && items.every((i) => i.variant_id)
      && !(await beyondEditTx(tx, ctx.accountId, orderId));
    const latest = edits[0];
    const asLines = (v: unknown): EditLineSnapshot[] => (Array.isArray(v) ? v as EditLineSnapshot[] : []);
    return {
      version: order.edit_version,
      blocked: !editable ? 'not_editable' : flags?.link ? 'payment_link_open' : flags?.refund ? 'refund_in_flight' : null,
      currency: order.currency,
      lines: items.map((i) => ({ id: i.id, variant_id: i.variant_id, name: i.name, sku: i.sku, quantity: i.quantity, shipped: i.shipped,
        unit_price_minor: minorFromDb(i.unit_price_minor) ?? 0 })),
      balance_due_minor: latest && latest.payment_action === 'collect' && latest.payment_state !== 'link_paid' && order.status !== 'cancelled'
        ? minorFromDb(latest.difference_minor) ?? 0 : 0,
      edits: edits.map((e) => ({
        id: e.id, reason: e.reason, actor_name: e.actor_name, total_before_minor: minorFromDb(e.total_before_minor) ?? 0,
        total_after_minor: minorFromDb(e.total_after_minor) ?? 0, payment_action: e.payment_action,
        difference_minor: minorFromDb(e.difference_minor) ?? 0, payment_state: e.payment_state, failure_code: e.failure_code,
        payment_link_url: e.payment_state === 'link_created' && e.link_status === 'created' ? e.link_url : null,
        lines_before: asLines(e.lines_before), lines_after: asLines(e.lines_after), created_at: e.created_at.toISOString(),
      })),
    };
  });
}
