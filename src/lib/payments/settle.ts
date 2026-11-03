/**
 * Settlement (design E7, E8, E9): the ONLY writer of the financial effects of
 * a customer payment. verifyAndSettle fetches the link and its payments from
 * Razorpay with the tenant's keys (outside any transaction), then
 * settlePaymentTx records the payment once per provider payment id and, under
 * the subject's row lock, credits the order or confirms the appointment, or
 * opens a payment exception. A webhook or a success page never settles.
 *
 * Lock order: customer_payments row -> order (or appointment) row -> inventory
 * rows (stock.ts). The amount due is computed here, at settle time, from the
 * order's own total and what was already credited, never from a value stored
 * when the link was made (the app role can insert links with any amount).
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from '@/lib/commerce/money';
import { capiValue, queueConversionEventTx } from '@/lib/meta-ads/capi';
import { orderWebhookData } from '@/lib/webhooks/commerce-events';
import { commitTx, rereserveTx } from '@/lib/commerce/stock';
import { confirmPaidHoldTx } from '@/lib/appointments/paid';
import { applyProviderState, notifyPaid, queuePaidWebhooksTx, queuePurchase, queueWebhookTx, selectLink, type LinkRow, type PaidOrderRow } from './links';
import { loadRazorpaySecrets, PaymentProviderError } from './providers';
import { fetchPayment, fetchPaymentLink, isCaptured, PAYMENT_ID } from './razorpay';
import { enqueueJobTx, openExceptionTx, orderEventTx, type ExceptionKind } from './ledger';

/** A payment proven captured by authoritative fetches, for one of our links. */
export interface VerifiedPayment {
  accountId: string;
  paymentLinkId: string;
  providerPaymentId: string;
  /** Razorpay key id the link was created with (payment_links.provider_key_id). */
  providerKeyId: string | null;
  /** The webhook payload's merchant account id, audit only. */
  providerAccountId: string | null;
  amountMinor: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed';
  method: string | null;
  capturedAt: Date | null;
}

export type SettleOutcome =
  | { kind: 'settled'; paymentId: string }
  | { kind: 'unattached'; paymentId: string }
  | { kind: 'exception'; paymentId: string; exception: string }
  | { kind: 'duplicate'; paymentId: string }
  | { kind: 'not_captured'; paymentId: string | null }
  | { kind: 'skipped'; reason: string };

export const ISSUE_RECEIPT_JOB = 'commerce.issue_receipt';

const worker = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

/**
 * Fetch, verify and settle every captured payment of one link (idempotent;
 * safe to run concurrently with a webhook job, a reconcile or the sweep).
 * Throws on a provider or connection failure so a job retries.
 */
export async function verifyAndSettle(accountId: string, linkId: string, hint: { providerAccountId?: string | null } = {}): Promise<SettleOutcome[]> {
  const row = await worker(accountId, (tx) => selectLink(tx, accountId, { id: linkId }));
  if (!row) return [{ kind: 'skipped', reason: 'not_found' }];
  if (!row.provider_link_id) return [{ kind: 'skipped', reason: 'no_provider_link' }];
  let secrets;
  try {
    secrets = await loadRazorpaySecrets(accountId);
  } catch (error) {
    if (error instanceof PaymentProviderError) return [{ kind: 'skipped', reason: 'not_connected' }];
    throw error;
  }
  // E8: never fetch a link made under other keys with the keys connected now.
  if (row.provider_key_id && row.provider_key_id !== secrets.keyId) {
    await worker(accountId, (tx) => openExceptionTx(tx, {
      accountId, kind: 'merchant_changed', subjectKey: `link:${row.id}`, paymentLinkId: row.id,
      orderId: row.order_id, appointmentId: row.appointment_id, detail: 'key_changed',
    }));
    return [{ kind: 'skipped', reason: 'merchant_changed' }];
  }
  const creds = { keyId: secrets.keyId, keySecret: secrets.keySecret };
  const link = await fetchPaymentLink({ ...creds, id: row.provider_link_id });
  if (link.id !== row.provider_link_id || link.referenceId !== row.reference_id) {
    await worker(accountId, (tx) => openExceptionTx(tx, {
      accountId, kind: 'payment_unmatched', subjectKey: `link:${row.id}`, paymentLinkId: row.id,
      orderId: row.order_id, appointmentId: row.appointment_id, detail: 'reference_mismatch',
    }));
    return [{ kind: 'skipped', reason: 'reference_mismatch' }];
  }
  // The fetched link is the truth for its own status too (a missed webhook, or a reconcile).
  if (link.status !== 'unknown' && link.status !== row.status) {
    await applyProviderState(accountId, row.id, { status: link.status, providerLinkId: link.id, shortUrl: link.shortUrl, expireBy: link.expireBy }, 'fetch');
  }
  const outcomes: SettleOutcome[] = [];
  const seen = new Set<string>();
  for (const entry of link.payments) {
    if (seen.has(entry.paymentId) || !PAYMENT_ID.test(entry.paymentId)) continue;
    seen.add(entry.paymentId);
    // (b) the payment itself, with the same keys; its id came from the link's own payments[].
    const payment = await fetchPayment({ ...creds, id: entry.paymentId });
    const status: VerifiedPayment['status'] | null = isCaptured(payment) ? 'captured' : payment.status === 'authorized' ? 'authorized' : null;
    if (!status || payment.amountMinor <= 0) {
      outcomes.push({ kind: 'not_captured', paymentId: null });
      continue;
    }
    const verified: VerifiedPayment = {
      accountId, paymentLinkId: row.id, providerPaymentId: payment.id, providerKeyId: row.provider_key_id,
      providerAccountId: hint.providerAccountId ?? null, amountMinor: payment.amountMinor, currency: payment.currency,
      status, method: payment.method, capturedAt: payment.createdAt ? new Date(payment.createdAt * 1000) : null,
    };
    outcomes.push(await worker(accountId, (tx) => settlePaymentTx(tx, verified)));
  }
  if (!outcomes.length) outcomes.push({ kind: 'not_captured', paymentId: null });
  return outcomes;
}

interface PaymentRow {
  id: string;
  status: string;
  settlement: string;
  amount_minor: bigint | number;
  currency: string;
}

export interface OrderLockRow {
  id: string;
  status: string;
  source: string;
  external_id: string | null;
  priced_at: Date | null;
  total_minor: bigint | number | null;
  subtotal_minor: bigint | number;
  amount_paid_minor: bigint | number;
  currency: string;
  contact_id: string | null;
  conversation_id: string | null;
}

/** The order row under FOR UPDATE (the caller already holds the payment row lock when there is one). */
export async function lockOrderTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<OrderLockRow | null> {
  const rows = await tx.$queryRaw<OrderLockRow[]>`
    SELECT id::text AS id,status,source,external_id,priced_at,total_minor,subtotal_minor,amount_paid_minor,currency,
      contact_id::text AS contact_id,conversation_id::text AS conversation_id
    FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid FOR UPDATE`;
  return rows[0] ?? null;
}

/** What is still due on an order: its own total (or the cart subtotal of a legacy order) minus what was credited. */
export function orderDue(order: Pick<OrderLockRow, 'total_minor' | 'subtotal_minor' | 'amount_paid_minor'>): number {
  const total = minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0;
  return total - (minorFromDb(order.amount_paid_minor) ?? 0);
}

/** Order statuses a payment can be credited to directly. 'expired' needs its stock back first. */
const PAYABLE = new Set(['new', 'confirmed', 'awaiting_payment']);
const ALREADY_PAID = new Set(['paid', 'dispatched', 'fulfilled', 'payment_review']);

/**
 * How a payment for this order would settle, before any write (design E9).
 * 'credit' and 'late' credit it; anything else is an exception kind.
 */
export function orderSettlementPlan(order: Pick<OrderLockRow, 'status' | 'currency' | 'total_minor' | 'subtotal_minor' | 'amount_paid_minor'>,
  payment: { amountMinor: number; currency: string }): 'credit' | 'late' | ExceptionKind {
  if (order.status === 'cancelled') return 'payment_on_closed_order';
  if (ALREADY_PAID.has(order.status)) return 'duplicate_payment';
  if (!PAYABLE.has(order.status) && order.status !== 'expired') return 'payment_on_closed_order';
  if (payment.currency !== order.currency) return 'currency_mismatch';
  const due = orderDue(order);
  if (due <= 0) return 'duplicate_payment';
  if (payment.amountMinor !== due) return 'amount_mismatch';
  return order.status === 'expired' ? 'late' : 'credit';
}

/**
 * Credits a payment row to an order the caller has locked: commits its stock
 * (a priced order), commits the coupon, moves it to paid, adds the amount and
 * queues the receipt, Purchase, order.paid and (for a link) payment_link.paid
 * and the agent alert, all in this transaction. `late` first takes the stock
 * back (rereserve); returns false, writing nothing, when it is gone.
 */
export async function creditOrderTx(tx: TenantTransaction, input: {
  accountId: string;
  order: OrderLockRow;
  paymentId: string;
  amountMinor: number;
  link: LinkRow | null;
  late: boolean;
  actorUserId: string | null;
}): Promise<boolean> {
  const { accountId, order } = input;
  if (input.late) {
    if (!(await rereserveTx(tx, accountId, order.id))) return false;
  }
  if (order.priced_at) await commitTx(tx, accountId, order.id);
  const coupons = await tx.$queryRaw<{ coupon_id: string; was: string }[]>`
    UPDATE coupon_redemptions r SET status='committed' FROM (SELECT id, status AS was FROM coupon_redemptions
      WHERE account_id=${accountId}::uuid AND order_id=${order.id}::uuid AND status<>'committed') p
    WHERE r.id=p.id RETURNING r.coupon_id::text AS coupon_id, p.was`;
  const paid = await tx.$queryRaw<PaidOrderRow[]>`UPDATE orders o SET status='paid', paid_at=COALESCE(o.paid_at, now()),
      amount_paid_minor=o.amount_paid_minor + ${BigInt(input.amountMinor)}
    WHERE o.account_id=${accountId}::uuid AND o.id=${order.id}::uuid
    RETURNING o.id::text AS id,o.source,o.external_id,o.status,o.total_minor,o.subtotal_minor,o.currency,
      o.contact_id::text AS contact_id,o.conversation_id::text AS conversation_id,
      (SELECT count(*)::int FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id) AS item_count`;
  await tx.$executeRaw`UPDATE customer_payments SET settlement='settled', order_id=${order.id}::uuid
    WHERE account_id=${accountId}::uuid AND id=${input.paymentId}::uuid`;
  await orderEventTx(tx, accountId, order.id, input.link ? 'payment_captured' : 'payment_recorded', { actorUserId: input.actorUserId });
  if (input.late) {
    await orderEventTx(tx, accountId, order.id, 'late_payment_restocked');
    for (const c of coupons.filter((x) => x.was === 'released')) {
      // Reinstated even above its limit: the customer already paid the discounted total.
      const over = await tx.$queryRaw<{ over: boolean }[]>`SELECT (c.max_redemptions IS NOT NULL AND
        (SELECT count(*) FROM coupon_redemptions r WHERE r.account_id=c.account_id AND r.coupon_id=c.id AND r.status<>'released') > c.max_redemptions) AS over
        FROM coupons c WHERE c.account_id=${accountId}::uuid AND c.id=${c.coupon_id}::uuid`;
      if (over[0]?.over) await orderEventTx(tx, accountId, order.id, 'coupon_over_limit');
    }
  }
  await enqueueJobTx(tx, accountId, ISSUE_RECEIPT_JOB, { paymentId: input.paymentId }, `receipt:${input.paymentId}`);
  const paidOrder = paid[0] ?? null;
  if (input.link) {
    await notifyPaid(tx, input.link);
    await queuePurchase(tx, accountId, input.link, paidOrder);
    await queuePaidWebhooksTx(tx, accountId, input.link, paidOrder);
  } else if (paidOrder) {
    const total = minorFromDb(paidOrder.total_minor ?? paidOrder.subtotal_minor);
    await queueConversionEventTx(tx, {
      accountId, eventName: 'Purchase', source: 'order', sourceId: paidOrder.id, orderId: paidOrder.id,
      contactId: paidOrder.contact_id, value: capiValue(total, paidOrder.currency), currency: paidOrder.currency,
    });
    await queueWebhookTx(tx, accountId, 'order.paid', paidOrder.id, orderWebhookData({
      orderId: paidOrder.id, source: paidOrder.source, externalId: paidOrder.external_id, status: paidOrder.status,
      totalMinor: total, currency: paidOrder.currency, itemCount: paidOrder.item_count,
      contactId: paidOrder.contact_id, conversationId: paidOrder.conversation_id,
    }));
  }
  return true;
}

async function markException(tx: TenantTransaction, accountId: string, paymentId: string, kind: ExceptionKind,
  subject: { orderId?: string | null; appointmentId?: string | null; linkId?: string | null }, detail?: string): Promise<SettleOutcome> {
  await tx.$executeRaw`UPDATE customer_payments SET settlement='exception' WHERE account_id=${accountId}::uuid AND id=${paymentId}::uuid`;
  await openExceptionTx(tx, {
    accountId, kind, subjectKey: `payment:${paymentId}`, paymentId, orderId: subject.orderId ?? null,
    appointmentId: subject.appointmentId ?? null, paymentLinkId: subject.linkId ?? null, detail: detail ?? null,
  });
  if (subject.orderId) await orderEventTx(tx, accountId, subject.orderId, 'payment_exception', { detail: kind });
  return { kind: 'exception', paymentId, exception: kind };
}

/** Record and settle one verified payment inside the caller's worker transaction. */
export async function settlePaymentTx(tx: TenantTransaction, verified: VerifiedPayment): Promise<SettleOutcome> {
  const accountId = verified.accountId;
  if (!PAYMENT_ID.test(verified.providerPaymentId) || !Number.isSafeInteger(verified.amountMinor) || verified.amountMinor <= 0)
    return { kind: 'skipped', reason: 'invalid_payment' };
  if (verified.status === 'failed') return { kind: 'not_captured', paymentId: null };
  const link = await selectLink(tx, accountId, { id: verified.paymentLinkId });
  if (!link) return { kind: 'skipped', reason: 'link_not_found' };

  // 1. One row per gateway payment, then its lock: the first holder settles, every later caller sees it done.
  await tx.$executeRaw`INSERT INTO customer_payments(account_id,source,provider_payment_id,provider_account_id,payment_link_id,order_id,appointment_id,
      amount_minor,currency,status,method,captured_at)
    VALUES(${accountId}::uuid,'razorpay',${verified.providerPaymentId},${verified.providerAccountId},${link.id}::uuid,${link.order_id}::uuid,
      ${link.appointment_id}::uuid,${BigInt(verified.amountMinor)},${verified.currency},${verified.status},${verified.method},
      ${verified.status === 'captured' ? verified.capturedAt ?? new Date() : null})
    ON CONFLICT (account_id,provider_payment_id) DO NOTHING`;
  const rows = await tx.$queryRaw<PaymentRow[]>`SELECT id::text AS id,status,settlement,amount_minor,currency FROM customer_payments
    WHERE account_id=${accountId}::uuid AND provider_payment_id=${verified.providerPaymentId} FOR UPDATE`;
  const payment = rows[0];
  if (!payment) return { kind: 'skipped', reason: 'not_recorded' };
  if (payment.settlement !== 'pending') return { kind: 'duplicate', paymentId: payment.id };
  if (verified.status !== 'captured') return { kind: 'not_captured', paymentId: payment.id };
  if (payment.status !== 'captured') {
    await tx.$executeRaw`UPDATE customer_payments SET status='captured', method=COALESCE(${verified.method}, method),
      captured_at=COALESCE(captured_at, ${verified.capturedAt ?? new Date()}) WHERE account_id=${accountId}::uuid AND id=${payment.id}::uuid`;
  }
  const subject = { orderId: link.order_id, appointmentId: link.appointment_id, linkId: link.id };

  // 2. The link itself: amount and currency as created, and still the connected merchant (E8).
  if (verified.currency !== link.currency) return markException(tx, accountId, payment.id, 'currency_mismatch', subject, 'link_currency');
  if (verified.amountMinor !== minorFromDb(link.amount_minor)) return markException(tx, accountId, payment.id, 'amount_mismatch', subject, 'link_amount');
  if (link.provider_key_id) {
    const keys = await tx.$queryRaw<{ key_id: string }[]>`SELECT key_id FROM payment_providers WHERE account_id=${accountId}::uuid AND provider='razorpay'`;
    if (keys[0]?.key_id !== link.provider_key_id) return markException(tx, accountId, payment.id, 'merchant_changed', subject, 'key_changed');
  }

  // 3. The subject, under its row lock.
  if (link.order_id) {
    const order = await lockOrderTx(tx, accountId, link.order_id);
    if (!order) return markException(tx, accountId, payment.id, 'payment_on_closed_order', { ...subject, orderId: null }, 'order_missing');
    const plan = orderSettlementPlan(order, verified);
    if (plan !== 'credit' && plan !== 'late') return markException(tx, accountId, payment.id, plan, subject);
    const credited = await creditOrderTx(tx, { accountId, order, paymentId: payment.id, amountMinor: verified.amountMinor, link, late: plan === 'late', actorUserId: null });
    if (!credited) {
      // Paid after the hold expired and the stock is gone: never fulfilled silently (E9).
      await tx.$executeRaw`UPDATE orders SET status='payment_review' WHERE account_id=${accountId}::uuid AND id=${order.id}::uuid`;
      return markException(tx, accountId, payment.id, 'late_payment_no_stock', subject);
    }
    return { kind: 'settled', paymentId: payment.id };
  }

  if (link.appointment_id) {
    const appts = await tx.$queryRaw<{ status: string; payment_status: string; price_minor: bigint | number | null; currency: string | null }[]>`
      SELECT status,payment_status,price_minor,currency FROM appointments
      WHERE account_id=${accountId}::uuid AND id=${link.appointment_id}::uuid FOR UPDATE`;
    const appt = appts[0];
    if (!appt) return markException(tx, accountId, payment.id, 'payment_on_closed_order', { ...subject, appointmentId: null }, 'appointment_missing');
    if (appt.payment_status === 'paid' || appt.payment_status === 'refunded') return markException(tx, accountId, payment.id, 'duplicate_payment', subject);
    if (appt.currency !== verified.currency) return markException(tx, accountId, payment.id, 'currency_mismatch', subject, 'appointment_currency');
    if (minorFromDb(appt.price_minor) !== verified.amountMinor) return markException(tx, accountId, payment.id, 'amount_mismatch', subject, 'appointment_price');
    const outcome = await confirmPaidHoldTx(tx, {
      accountId, appointmentId: link.appointment_id, paymentId: payment.id, amountMinor: verified.amountMinor, currency: verified.currency,
    });
    if (outcome.kind === 'slot_lost') return markException(tx, accountId, payment.id, 'late_payment_slot_lost', subject);
    if (outcome.kind === 'not_payable') {
      // T6 outcome mapping: only 'confirmed' (or a replay) settles the payment.
      const kind: ExceptionKind = outcome.reason === 'duplicate_payment' || outcome.reason === 'amount_mismatch' || outcome.reason === 'currency_mismatch'
        ? outcome.reason : 'payment_on_closed_order';
      return markException(tx, accountId, payment.id, kind, subject, outcome.reason);
    }
    if (outcome.kind === 'already_confirmed') return { kind: 'duplicate', paymentId: payment.id };
    await tx.$executeRaw`UPDATE customer_payments SET settlement='settled' WHERE account_id=${accountId}::uuid AND id=${payment.id}::uuid`;
    await enqueueJobTx(tx, accountId, ISSUE_RECEIPT_JOB, { paymentId: payment.id }, `receipt:${payment.id}`);
    await notifyPaid(tx, link);
    await queuePurchase(tx, accountId, link, null);
    await queuePaidWebhooksTx(tx, accountId, link, null);
    return { kind: 'settled', paymentId: payment.id };
  }

  // A plain link: counted in collections, credits nothing (its alerts went out with the link's paid status).
  await tx.$executeRaw`UPDATE customer_payments SET settlement='unattached' WHERE account_id=${accountId}::uuid AND id=${payment.id}::uuid`;
  return { kind: 'unattached', paymentId: payment.id };
}

/** A verified paid event for one of our reference prefixes with no row in this workspace: surfaced, never credited. */
export async function openUnmatchedLinkException(accountId: string, providerLinkId: string): Promise<void> {
  if (!/^plink_[A-Za-z0-9]{1,40}$/.test(providerLinkId)) return;
  await worker(accountId, (tx) => openExceptionTx(tx, { accountId, kind: 'payment_unmatched', subjectKey: `link:${providerLinkId}`, detail: 'no_link_row' }));
}
