/**
 * Store credit and loyalty points ledgers (store plan Phase 8). Both are
 * append-only: a balance is the sum of a contact's entries and never goes
 * below zero (a table trigger refuses the entry, under the same per-contact
 * advisory lock ledgerLockTx takes, so two checkouts cannot overspend).
 * Amounts are integer minor units; points are whole numbers.
 *
 * How an order uses them:
 *  - Place (checkout.ts) spends what the quote showed, after the stock is
 *    held: applyOrderTenderTx re-reads the balances under the lock and refuses
 *    (quote_changed) when they no longer cover it. The spent amounts are kept
 *    on the order (store_credit_minor, points_redeemed, points_value_minor)
 *    and counted in amount_paid_minor, so what is due stays total minus paid.
 *  - Every later write for an order runs under the order row lock and works
 *    from the order's net entries, so a replay writes nothing: spending twice,
 *    reversing twice and earning twice are all no-ops.
 *  - Cancel or expiry gives the spend back (reverseOrderTenderTx) and takes it
 *    out of amount_paid_minor.
 *  - Points are earned once per order when it is paid (earnForOrderTx, key
 *    earn:<order>), on the order total minus the part paid with points. A
 *    refund takes back the same share of them as the share of that amount
 *    refunded so far (reverseEarnForRefundTx); a cancelled order gives back all
 *    of them. Taking back never makes the balance negative: at most what the
 *    contact still has.
 *
 * Lock order: the order row, then inventory, then the ledger lock.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from './money';
import { earnReversal, pointsEarned, type PricingTender } from './price-rules';
import { StoreError } from './store-settings';

export interface LoyaltySettings {
  enabled: boolean;
  earnPoints: number;
  earnSpendMinor: number;
  redeemValueMinor: number;
  redeemMaxBps: number;
}

export const LOYALTY_DEFAULTS: LoyaltySettings = { enabled: false, earnPoints: 1, earnSpendMinor: 10_000, redeemValueMinor: 100, redeemMaxBps: 2_000 };

export async function loadLoyaltyTx(tx: TenantTransaction, accountId: string): Promise<LoyaltySettings> {
  const [row] = await tx.$queryRaw<{ enabled: boolean; earn_points: number; earn_spend_minor: bigint; redeem_value_minor: bigint; redeem_max_bps: number }[]>`
    SELECT enabled, earn_points, earn_spend_minor, redeem_value_minor, redeem_max_bps FROM shop_loyalty_settings WHERE account_id=${accountId}::uuid`;
  if (!row) return LOYALTY_DEFAULTS;
  return {
    enabled: row.enabled, earnPoints: row.earn_points, earnSpendMinor: minorFromDb(row.earn_spend_minor) ?? 0,
    redeemValueMinor: minorFromDb(row.redeem_value_minor) ?? 0, redeemMaxBps: row.redeem_max_bps,
  };
}

/** Serialise every writer of one contact's ledgers for the rest of the transaction (the key the table triggers use). */
export async function ledgerLockTx(tx: TenantTransaction, accountId: string, contactId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('shop-ledger:' || ${accountId}::uuid::text || ':' || ${contactId}::uuid::text, 0))`;
}

export async function creditBalanceTx(tx: TenantTransaction, accountId: string, contactId: string, currency: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ balance: bigint }[]>`SELECT COALESCE(sum(amount_minor), 0)::bigint AS balance FROM shop_credit_ledger
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND currency=${currency}`;
  return Math.max(0, minorFromDb(row?.balance) ?? 0);
}

export async function pointsBalanceTx(tx: TenantTransaction, accountId: string, contactId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ balance: bigint }[]>`SELECT COALESCE(sum(points), 0)::bigint AS balance FROM shop_points_ledger
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`;
  return Math.max(0, Number(row?.balance ?? 0));
}

export interface BuyerBalances {
  storeCreditMinor: number;
  points: number;
  /** What one point pays and the cap, when loyalty is on; null when it is off. */
  redeem: { valueMinor: number; maxBps: number } | null;
}

/** What the buyer has, for the cart page and for pricing. */
export async function buyerBalancesTx(tx: TenantTransaction, accountId: string, contactId: string, currency: string): Promise<BuyerBalances> {
  const loyalty = await loadLoyaltyTx(tx, accountId);
  return {
    storeCreditMinor: await creditBalanceTx(tx, accountId, contactId, currency),
    points: loyalty.enabled ? await pointsBalanceTx(tx, accountId, contactId) : 0,
    redeem: loyalty.enabled ? { valueMinor: loyalty.redeemValueMinor, maxBps: loyalty.redeemMaxBps } : null,
  };
}

/** The tender priceCart reads: only what the buyer switched on, at their current balances. */
export function tenderOf(balances: BuyerBalances, choice: { useCredit: boolean; usePoints: boolean }): PricingTender | null {
  if (!choice.useCredit && !choice.usePoints) return null;
  return {
    storeCreditMinor: choice.useCredit ? balances.storeCreditMinor : 0,
    points: choice.usePoints && balances.redeem && balances.points > 0
      ? { balance: balances.points, valueMinor: balances.redeem.valueMinor, maxBps: balances.redeem.maxBps } : null,
  };
}

interface OrderNet { credit: number; points: number; entries: number }

/** What the order has spent and not got back, from its own ledger entries. Caller holds the order row lock. */
async function orderNetTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<OrderNet> {
  const [credit] = await tx.$queryRaw<{ net: bigint; n: number }[]>`SELECT COALESCE(-sum(amount_minor), 0)::bigint AS net, count(*)::int AS n
    FROM shop_credit_ledger WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind IN ('spend','spend_reversal')`;
  const [points] = await tx.$queryRaw<{ net: bigint; n: number }[]>`SELECT COALESCE(-sum(points), 0)::bigint AS net, count(*)::int AS n
    FROM shop_points_ledger WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind IN ('redeem','redeem_reversal')`;
  return { credit: minorFromDb(credit?.net) ?? 0, points: Number(points?.net ?? 0), entries: (credit?.n ?? 0) + (points?.n ?? 0) };
}

/**
 * Spend the store credit and points the quote showed, for an order row this
 * transaction holds (inserted or locked). Idempotent: an order that already
 * holds its spend writes nothing. Throws quote_changed when a balance no
 * longer covers it (another checkout spent it first).
 */
export async function applyOrderTenderTx(tx: TenantTransaction, accountId: string, input: {
  orderId: string; contactId: string; currency: string; creditMinor: number; points: number;
}): Promise<void> {
  if (input.creditMinor <= 0 && input.points <= 0) return;
  await ledgerLockTx(tx, accountId, input.contactId);
  const net = await orderNetTx(tx, accountId, input.orderId);
  const credit = input.creditMinor - net.credit, points = input.points - net.points;
  if (credit < 0 || points < 0) throw new StoreError('conflict');
  if (credit > 0) {
    if ((await creditBalanceTx(tx, accountId, input.contactId, input.currency)) < credit) throw new StoreError('quote_changed');
    await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,order_id,dedupe_key)
      VALUES(${accountId}::uuid,${input.contactId}::uuid,${BigInt(-credit)},${input.currency},'spend',${input.orderId}::uuid,
        ${`order:${input.orderId}:credit:${net.entries}`})`;
  }
  if (points > 0) {
    if ((await pointsBalanceTx(tx, accountId, input.contactId)) < points) throw new StoreError('quote_changed');
    await tx.$executeRaw`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,order_id,dedupe_key)
      VALUES(${accountId}::uuid,${input.contactId}::uuid,${-points},'redeem',${input.orderId}::uuid,${`order:${input.orderId}:points:${net.entries}`})`;
  }
}

/**
 * Give back what an order spent in store credit and points (it was cancelled,
 * or expired unpaid) and take it out of amount_paid_minor. Caller holds the
 * order row lock. A second call finds nothing left to give back.
 */
export async function reverseOrderTenderTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<{ creditMinor: number; points: number }> {
  const [order] = await tx.$queryRaw<{ contact_id: string | null; currency: string; store_credit_minor: bigint; points_redeemed: number; points_value_minor: bigint }[]>`
    SELECT contact_id::text AS contact_id, currency, store_credit_minor, points_redeemed, points_value_minor FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  if (!order?.contact_id || ((minorFromDb(order.store_credit_minor) ?? 0) === 0 && order.points_redeemed === 0)) return { creditMinor: 0, points: 0 };
  await ledgerLockTx(tx, accountId, order.contact_id);
  const net = await orderNetTx(tx, accountId, orderId);
  let paid = 0;
  if (net.credit > 0) {
    await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,order_id,dedupe_key)
      VALUES(${accountId}::uuid,${order.contact_id}::uuid,${BigInt(net.credit)},${order.currency},'spend_reversal',${orderId}::uuid,
        ${`order:${orderId}:credit:${net.entries}`})`;
    paid += net.credit;
  }
  if (net.points > 0) {
    await tx.$executeRaw`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,order_id,dedupe_key)
      VALUES(${accountId}::uuid,${order.contact_id}::uuid,${net.points},'redeem_reversal',${orderId}::uuid,${`order:${orderId}:points:${net.entries}`})`;
    // The points are spent or returned whole, so their money value goes back whole too.
    paid += minorFromDb(order.points_value_minor) ?? 0;
  }
  if (paid > 0) {
    await tx.$executeRaw`UPDATE orders SET amount_paid_minor=GREATEST(amount_paid_minor - ${BigInt(paid)}, 0)
      WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    await tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor,detail) VALUES(${accountId}::uuid,${orderId}::uuid,'tender_returned','system',NULL)`;
  }
  return { creditMinor: net.credit, points: net.points };
}

/**
 * Points for a paid order, once (dedupe key earn:<order>; a replayed payment
 * finds the entry). Earned on the order total minus what points paid. Nothing
 * when loyalty is off, the order has no contact, or the amount earns less
 * than one point.
 */
export async function earnForOrderTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<number> {
  const loyalty = await loadLoyaltyTx(tx, accountId);
  if (!loyalty.enabled) return 0;
  const [order] = await tx.$queryRaw<{ contact_id: string | null; total_minor: bigint | null; subtotal_minor: bigint; points_value_minor: bigint }[]>`
    SELECT contact_id::text AS contact_id, total_minor, subtotal_minor, points_value_minor FROM orders
    WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid AND paid_at IS NOT NULL`;
  if (!order?.contact_id) return 0;
  const base = (minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0) - (minorFromDb(order.points_value_minor) ?? 0);
  const points = pointsEarned(base, loyalty);
  if (points <= 0) return 0;
  const inserted = await tx.$executeRaw`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,order_id,dedupe_key)
    VALUES(${accountId}::uuid,${order.contact_id}::uuid,${points},'earn',${orderId}::uuid,${`earn:${orderId}`})
    ON CONFLICT (account_id, dedupe_key) DO NOTHING`;
  return inserted ? points : 0;
}

/**
 * Take earned points back. `refundId`: after a processed refund, the share
 * the money refunded so far is of the earning amount. null: the whole order
 * was cancelled, all of what is left. Never more than the contact still has.
 * Caller holds the order row lock; the dedupe key makes a replay a no-op.
 */
export async function reverseEarnTx(tx: TenantTransaction, accountId: string, orderId: string, refundId: string | null): Promise<number> {
  const [order] = await tx.$queryRaw<{ contact_id: string | null; total_minor: bigint | null; subtotal_minor: bigint; points_value_minor: bigint;
    amount_refunded_minor: bigint; earned: bigint; reversed: bigint }[]>`
    SELECT o.contact_id::text AS contact_id, o.total_minor, o.subtotal_minor, o.points_value_minor, o.amount_refunded_minor,
      COALESCE((SELECT sum(points) FROM shop_points_ledger l WHERE l.account_id=o.account_id AND l.order_id=o.id AND l.kind='earn'), 0)::bigint AS earned,
      COALESCE((SELECT -sum(points) FROM shop_points_ledger l WHERE l.account_id=o.account_id AND l.order_id=o.id AND l.kind='earn_reversal'), 0)::bigint AS reversed
    FROM orders o WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
  const earned = Number(order?.earned ?? 0), reversed = Number(order?.reversed ?? 0);
  if (!order?.contact_id || earned <= 0) return 0;
  const base = (minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0) - (minorFromDb(order.points_value_minor) ?? 0);
  const wanted = refundId ? earnReversal(earned, reversed, minorFromDb(order.amount_refunded_minor) ?? 0, base) : earned - reversed;
  if (wanted <= 0) return 0;
  await ledgerLockTx(tx, accountId, order.contact_id);
  const take = Math.min(wanted, await pointsBalanceTx(tx, accountId, order.contact_id));
  if (take <= 0) return 0;
  const inserted = await tx.$executeRaw`INSERT INTO shop_points_ledger(account_id,contact_id,points,kind,order_id,refund_id,dedupe_key)
    VALUES(${accountId}::uuid,${order.contact_id}::uuid,${-take},'earn_reversal',${orderId}::uuid,${refundId}::uuid,
      ${refundId ? `earn-rev:${refundId}` : `earn-rev:cancel:${orderId}`})
    ON CONFLICT (account_id, dedupe_key) DO NOTHING`;
  return inserted ? take : 0;
}
