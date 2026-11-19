/**
 * Staff operations on store credit and loyalty points (store plan Phase 8).
 * The ledgers and their arithmetic are in customer-ledger.ts.
 *
 *  - Loyalty settings: agents read, admins save (app role; RLS enforces it).
 *  - A contact's balances and latest entries: agents and above.
 *  - Adjust a balance: admins only, with a reason, in their own name (app
 *    role; the admin_adjust policy lets nothing else through). The request id
 *    makes a repeated click one entry. A balance never goes below zero.
 *  - Refund to store credit: the refund is recorded on the payment exactly as
 *    a refund made outside the gateway (processed at once, so the refunded
 *    amounts, the restock and the credit note follow), marked store_credit,
 *    and the same amount is added to the contact's credit in the same
 *    transaction (key refund:<refund id>). No money leaves the gateway.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { auditTx, orderEventTx, stableUuid } from '@/lib/payments/ledger';
import { applyRefundStateTx, REFUND_REASONS, RefundError, type RefundReason } from '@/lib/payments/refunds';
import { creditBalanceTx, ledgerLockTx, loadLoyaltyTx, pointsBalanceTx, type LoyaltySettings } from './customer-ledger';
import { minorFromDb } from './money';
import { asStaff, liveShipmentExists, lockSettledPayments, type StaffContext } from './order-lifecycle';
import { MAX_POINTS } from './price-rules';
import { auditStoreChange, isUuid, lockStoreCurrencyShared, StoreError } from './store-settings';

type Admin = TenantContext & { userId: string };
const MAX_ADJUST_MINOR = 100_000_000_000;

// ---------------------------------------------------------------------------
// Loyalty settings

export interface LoyaltySettingsView {
  enabled: boolean;
  earn_points: number;
  earn_spend_minor: number;
  redeem_value_minor: number;
  redeem_max_bps: number;
}

const toView = (s: LoyaltySettings): LoyaltySettingsView => ({
  enabled: s.enabled, earn_points: s.earnPoints, earn_spend_minor: s.earnSpendMinor, redeem_value_minor: s.redeemValueMinor, redeem_max_bps: s.redeemMaxBps,
});

function int(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new StoreError('invalid', { field });
  return value;
}

export function parseLoyaltySettings(body: unknown): LoyaltySettingsView {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') throw new StoreError('invalid', { field: 'enabled' });
  return {
    enabled: b.enabled, earn_points: int(b.earn_points, 1, 1000, 'earn_points'),
    earn_spend_minor: int(b.earn_spend_minor, 1, MAX_ADJUST_MINOR, 'earn_spend_minor'),
    redeem_value_minor: int(b.redeem_value_minor, 1, 100_000_000, 'redeem_value_minor'),
    redeem_max_bps: int(b.redeem_max_bps, 1, 10_000, 'redeem_max_bps'),
  };
}

export function getLoyaltySettings(ctx: TenantContext): Promise<LoyaltySettingsView> {
  return withTenant(ctx, async (tx) => toView(await loadLoyaltyTx(tx, ctx.accountId)));
}

export async function saveLoyaltySettings(ctx: Admin, input: LoyaltySettingsView): Promise<LoyaltySettingsView> {
  return withTenant(ctx, async (tx) => {
    await lockStoreCurrencyShared(tx, ctx.accountId); // the amounts are in the store currency
    await tx.$executeRaw`INSERT INTO shop_loyalty_settings(account_id,enabled,earn_points,earn_spend_minor,redeem_value_minor,redeem_max_bps)
      VALUES(${ctx.accountId}::uuid,${input.enabled},${input.earn_points},${input.earn_spend_minor},${input.redeem_value_minor},${input.redeem_max_bps})
      ON CONFLICT (account_id) DO UPDATE SET enabled=EXCLUDED.enabled,earn_points=EXCLUDED.earn_points,earn_spend_minor=EXCLUDED.earn_spend_minor,
        redeem_value_minor=EXCLUDED.redeem_value_minor,redeem_max_bps=EXCLUDED.redeem_max_bps`;
    await auditStoreChange(tx, ctx, 'commerce.loyalty_settings_saved', ctx.accountId, { enabled: input.enabled });
    return toView(await loadLoyaltyTx(tx, ctx.accountId));
  });
}

// ---------------------------------------------------------------------------
// Balances

export interface LedgerEntryView { kind: string; amount: number; reason: string | null; order_id: string | null; created_at: string }
export interface ContactBalances {
  contact_id: string;
  contact_name: string | null;
  currency: string | null;
  store_credit_minor: number;
  points: number;
  credit_entries: LedgerEntryView[];
  point_entries: LedgerEntryView[];
}

/** A contact's balances and its latest 20 entries of each ledger (agents and above). */
export async function getContactBalances(ctx: TenantContext, contactId: string): Promise<ContactBalances> {
  if (!isUuid(contactId)) throw new StoreError('contact_not_found');
  return withTenant(ctx, async (tx) => {
    const [contact] = await tx.$queryRaw<{ name: string | null }[]>`SELECT name FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${contactId}::uuid`;
    if (!contact) throw new StoreError('contact_not_found');
    const [settings] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
    const currency = settings?.currency ?? null;
    type Row = { kind: string; amount: bigint | number; reason: string | null; order_id: string | null; created_at: Date };
    const entry = (r: Row): LedgerEntryView => ({ kind: r.kind, amount: Number(r.amount), reason: r.reason, order_id: r.order_id, created_at: r.created_at.toISOString() });
    const credit = await tx.$queryRaw<Row[]>`SELECT kind, amount_minor AS amount, reason, order_id::text AS order_id, created_at FROM shop_credit_ledger
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC, id LIMIT 20`;
    const points = await tx.$queryRaw<Row[]>`SELECT kind, points AS amount, reason, order_id::text AS order_id, created_at FROM shop_points_ledger
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC, id LIMIT 20`;
    return {
      contact_id: contactId, contact_name: contact.name, currency,
      store_credit_minor: currency ? await creditBalanceTx(tx, ctx.accountId, contactId, currency) : 0,
      points: await pointsBalanceTx(tx, ctx.accountId, contactId),
      credit_entries: credit.map(entry), point_entries: points.map(entry),
    };
  });
}

export interface AdjustInput { contactId: string; ledger: 'credit' | 'points'; amount: number; reason: string; clientRequestId: string }

export function parseAdjust(body: unknown): AdjustInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!isUuid(b.contact_id)) throw new StoreError('invalid', { field: 'contact_id' });
  if (!isUuid(b.client_request_id)) throw new StoreError('invalid', { field: 'client_request_id' });
  if (b.ledger !== 'credit' && b.ledger !== 'points') throw new StoreError('invalid', { field: 'ledger' });
  const max = b.ledger === 'credit' ? MAX_ADJUST_MINOR : MAX_POINTS;
  if (typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount === 0 || Math.abs(b.amount) > max) throw new StoreError('invalid', { field: 'amount' });
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason || reason.length > 200 || /\p{Cc}/u.test(reason)) throw new StoreError('invalid', { field: 'reason' });
  return { contactId: b.contact_id.toLowerCase(), ledger: b.ledger, amount: b.amount, reason, clientRequestId: b.client_request_id.toLowerCase() };
}

/**
 * Add to or take from a contact's store credit (minor units) or points, with a
 * reason. Admins only. Taking more than the balance is refused
 * (store_credit_insufficient / points_insufficient). A replay of the same
 * request id changes nothing. Returns the new balance.
 */
export async function adjustBalance(ctx: Admin, input: AdjustInput): Promise<{ balance: number; created: boolean }> {
  return withTenant(ctx, async (tx) => {
    const [contact] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${input.contactId}::uuid`;
    if (!contact) throw new StoreError('contact_not_found');
    const key = `adjust:${ctx.userId}:${input.clientRequestId}`;
    await ledgerLockTx(tx, ctx.accountId, input.contactId);
    let created: number;
    let balance: number;
    if (input.ledger === 'credit') {
      await lockStoreCurrencyShared(tx, ctx.accountId);
      const [settings] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
      if (!settings?.currency) throw new StoreError('store_not_configured');
      const [replay] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_credit_ledger WHERE account_id=${ctx.accountId}::uuid AND dedupe_key=${key}`;
      if (!replay && (await creditBalanceTx(tx, ctx.accountId, input.contactId, settings.currency)) + input.amount < 0) throw new StoreError('store_credit_insufficient');
      created = replay ? 0 : await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,reason,dedupe_key,created_by)
        VALUES(${ctx.accountId}::uuid,${input.contactId}::uuid,${BigInt(input.amount)},${settings.currency},'adjust',${input.reason},${key},${ctx.userId}::uuid)`;
      balance = await creditBalanceTx(tx, ctx.accountId, input.contactId, settings.currency);
    } else {
      const [replay] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_points_ledger WHERE account_id=${ctx.accountId}::uuid AND dedupe_key=${key}`;
      if (!replay && (await pointsBalanceTx(tx, ctx.accountId, input.contactId)) + input.amount < 0) throw new StoreError('points_insufficient');
      created = replay ? 0 : await tx.$executeRaw`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,reason,dedupe_key,created_by)
        VALUES(${ctx.accountId}::uuid,${input.contactId}::uuid,${input.amount},'adjust',${input.reason},${key},${ctx.userId}::uuid)`;
      balance = await pointsBalanceTx(tx, ctx.accountId, input.contactId);
    }
    // Ids and amounts only: the reason stays in the ledger row.
    if (created) await auditStoreChange(tx, ctx, input.ledger === 'credit' ? 'commerce.store_credit_adjusted' : 'commerce.points_adjusted', input.contactId, { amount: input.amount });
    return { balance, created: created > 0 };
  });
}

// ---------------------------------------------------------------------------
// Refund to store credit

export interface CreditRefundRequest {
  paymentId: string;
  amountMinor: number;
  reason: RefundReason;
  note?: string | null;
  restock?: boolean;
  clientRequestId: string;
}

/**
 * Refund part or all of a settled order payment as store credit (permission
 * commerce.refunds, checked here). Refuses an amount above what the payment
 * can still refund, and an order with no contact to hold the credit. A replay
 * of the request id returns the first refund.
 */
export async function refundToStoreCredit(ctx: StaffContext, input: CreditRefundRequest): Promise<{ refundId: string }> {
  await requirePermission(ctx, 'commerce.refunds');
  if (!isUuid(input.paymentId) || !isUuid(input.clientRequestId)) throw new RefundError('not_found');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RefundError('invalid_amount');
  if (!(REFUND_REASONS as readonly string[]).includes(input.reason)) throw new RefundError('invalid_reason');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 500) throw new RefundError('invalid_note');
  const refundId = stableUuid(`refund:${ctx.accountId}:${ctx.userId}:${input.clientRequestId}`);
  return asStaff(ctx, async (tx) => {
    const [head] = await tx.$queryRaw<{ order_id: string | null }[]>`SELECT order_id::text AS order_id FROM customer_payments
      WHERE account_id=${ctx.accountId}::uuid AND id=${input.paymentId}::uuid`;
    if (!head) throw new RefundError('not_found');
    if (!head.order_id) throw new RefundError('not_refundable');
    // Lock order: the payments, then (inside applyRefundStateTx) the order, then the ledger.
    const settled = await lockSettledPayments(tx, ctx.accountId, head.order_id);
    const [replay] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_refunds WHERE account_id=${ctx.accountId}::uuid AND id=${refundId}::uuid`;
    if (replay) return { refundId };
    const payment = settled.find((p) => p.id === input.paymentId);
    if (!payment) throw new RefundError('not_refundable');
    if (input.amountMinor > (minorFromDb(payment.refundable) ?? 0)) throw new RefundError('amount_exceeds');
    const [order] = await tx.$queryRaw<{ contact_id: string | null }[]>`SELECT contact_id::text AS contact_id FROM orders
      WHERE account_id=${ctx.accountId}::uuid AND id=${head.order_id}::uuid`;
    if (!order?.contact_id) throw new RefundError('not_refundable');
    // As a gateway refund: no whole-order restock while a courier shipment may still leave with the goods.
    if (input.restock === true && (await liveShipmentExists(tx, ctx.accountId, head.order_id))) throw new RefundError('shipment_live');
    await tx.$executeRaw`INSERT INTO customer_refunds(id,account_id,payment_id,order_id,source,amount_minor,currency,reason_code,note,status,attempt,
        requested_by,restock,store_credit)
      VALUES(${refundId}::uuid,${ctx.accountId}::uuid,${payment.id}::uuid,${head.order_id}::uuid,'external',${BigInt(input.amountMinor)},${payment.currency},
        ${input.reason},${note || null},'pending',1,${ctx.userId}::uuid,${input.restock === true},true)`;
    await applyRefundStateTx(tx, ctx.accountId, payment, refundId, 'processed', null);
    await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,order_id,refund_id,dedupe_key,created_by)
      VALUES(${ctx.accountId}::uuid,${order.contact_id}::uuid,${BigInt(input.amountMinor)},${payment.currency},'refund',${head.order_id}::uuid,
        ${refundId}::uuid,${`refund:${refundId}`},${ctx.userId}::uuid)`;
    await orderEventTx(tx, ctx.accountId, head.order_id, 'refund_to_store_credit', { actorUserId: ctx.userId, detail: input.reason });
    await auditTx(tx, ctx.accountId, ctx.userId, 'commerce.refund_to_store_credit', refundId, {
      payment_id: payment.id, order_id: head.order_id, amount_minor: input.amountMinor, currency: payment.currency, reason: input.reason,
    });
    return { refundId };
  });
}
