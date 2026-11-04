/**
 * Checkout (design E2, E3, E6). Place is one worker transaction: reprice,
 * check the client's expectedTotalMinor, redeem the coupon, reserve stock,
 * write the line snapshots and totals, set priced_at and awaiting_payment, and
 * queue the reservation expiry and the checkout link jobs.
 *
 * Lock order (E5): storefront session -> contact advisory lock -> order ->
 * coupon -> inventory rows (ascending). A storefront order is inserted by this transaction, so no one
 * else can hold it; a WhatsApp cart's order row is locked before the coupon.
 *
 * Nothing here marks an order paid: payment links are created by a job after
 * commit and only verified settlement (lib/payments/settle.ts) moves the order
 * on. Logs carry ids and codes only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { requireFeature } from '@/lib/billing/entitlements';
import { isSuspended, requireSendingAllowed } from '@/lib/billing/suspension';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { engineSendTemplate } from '@/lib/automations/meta-send';
import { createPaymentLinkRecord, PaymentLinkError } from '@/lib/payments/links';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { getT } from '@/lib/i18n/translate';
import { lockCouponTx, redeemCouponTx, releaseCouponTx } from './coupons';
import { MARKETING_OPT_IN_VERSION } from './marketing-consent';
import { minorFromDb } from './money';
import { CART_LIMITS } from './pricing';
import { releaseTx, reserveTx, StockError } from './stock';
import {
  assertOpen, issueSessionTx, linkMessageText, loadOrder, loadSession, orderReference, OPEN_WINDOW_MS, quoteSessionTx,
  seededUuid, sendStorefrontText, STOREFRONT_TTL,
} from './storefront';
import { deriveStorefrontToken, storefrontUrl } from './storefront-token';
import { isUuid, loadPricingSettings, StoreError } from './store-settings';

/** commerce.prepare_whatsapp_order — dedupe prep:<orderId>, queued by recordWhatsAppOrder. */
export interface PrepareWhatsAppOrderJobPayload {
  orderId: string;
}

/** commerce.create_checkout_link — dedupe colink:<orderId>:<attempt>, queued by place. */
export interface CheckoutLinkJobPayload {
  orderId: string;
  attempt: number;
}

/** commerce.reservation_expiry — dedupe resv-exp:<orderId>:<attempt>, run at reservation_expires_at + 60 s. */
export interface ReservationExpiryJobPayload {
  orderId: string;
  attempt: number;
}

export const CHECKOUT_JOB_TYPES = {
  prepareWhatsAppOrder: 'commerce.prepare_whatsapp_order',
  createCheckoutLink: 'commerce.create_checkout_link',
  reservationExpiry: 'commerce.reservation_expiry',
} as const;

/** Razorpay refuses expire_by under 15 minutes; the link may outlive the hold (E6). */
const MIN_LINK_MINUTES = 16;

const worker = <T>(accountId: string, op: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, op, getWorkerPrisma());

/** The payment link reference for one checkout attempt of an order (prefix co_). */
export function checkoutPaymentReference(orderId: string, attempt: number): string {
  return `co_${createHash('sha256').update(`checkout:${orderId}:${attempt}`).digest('base64url').slice(0, 32)}`;
}

async function enqueue(tx: TenantTransaction, accountId: string, type: string, payload: object, dedupeKey: string, runAt: Date | null = null) {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${type},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},COALESCE(${runAt}::timestamptz, now()))
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

async function orderEvent(tx: TenantTransaction, accountId: string, orderId: string, kind: string, actor: 'customer' | 'system', detail: string | null = null) {
  await tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor,detail)
    VALUES(${accountId}::uuid,${orderId}::uuid,${kind},${actor},${detail})`;
}

// ---------------------------------------------------------------------------
// Per-contact holds

/**
 * Every order holds stock and a coupon redemption until it is paid or its
 * reservation expires, with no payment taken. Each WhatsApp cart and shop-link
 * run issues a fresh session, so the per-token place limit cannot stop one
 * contact holding the whole shelf: these caps count every live hold of the
 * contact instead.
 */
export const CONTACT_HOLD_LIMITS = { openOrders: 3, unitsPerVariant: CART_LIMITS.maxQty } as const;

/** The contact's orders awaiting payment with a live reservation, other than `excludeOrderId`. */
async function openOrderCountTx(tx: TenantTransaction, accountId: string, contactId: string, excludeOrderId: string | null, now: Date) {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM orders
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid AND status='awaiting_payment'
      AND reservation_expires_at > ${now} AND id IS DISTINCT FROM ${excludeOrderId}::uuid`;
  return row?.n ?? 0;
}

/**
 * Lock the contact's holds (a transaction advisory lock, taken before the
 * order row in lock order) and refuse when it already has the cap of open
 * orders. Two sessions of one contact placing at once are counted in turn.
 */
async function lockContactHoldsTx(tx: TenantTransaction, accountId: string, contactId: string, excludeOrderId: string | null, now: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`storefront-contact:${accountId}:${contactId}`}, 0))`;
  if (await openOrderCountTx(tx, accountId, contactId, excludeOrderId, now) >= CONTACT_HOLD_LIMITS.openOrders)
    throw new StoreError('too_many_open_orders');
}

/** Refuse when these lines would take the contact's live held units of a variant over the cap. Call under lockContactHoldsTx. */
async function assertVariantHoldsTx(tx: TenantTransaction, accountId: string, contactId: string,
  lines: Array<{ variantId: string; quantity: number }>, now: Date): Promise<void> {
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + l.quantity);
  for (const [variantId, q] of wanted)
    if (q > CONTACT_HOLD_LIMITS.unitsPerVariant) throw new StoreError('too_many_open_orders', { variantId });
  if (!wanted.size) return;
  const held = await tx.$queryRaw<{ variant_id: string; q: number }[]>`
    SELECT r.variant_id::text AS variant_id, sum(r.quantity)::int AS q FROM stock_reservations r
    JOIN orders o ON o.account_id=r.account_id AND o.id=r.order_id
    WHERE r.account_id=${accountId}::uuid AND o.contact_id=${contactId}::uuid AND r.status='held' AND r.expires_at > ${now}
      AND r.variant_id = ANY(${[...wanted.keys()]}::uuid[])
    GROUP BY r.variant_id ORDER BY r.variant_id`;
  for (const h of held)
    if (h.q + (wanted.get(h.variant_id) ?? 0) > CONTACT_HOLD_LIMITS.unitsPerVariant)
      throw new StoreError('too_many_open_orders', { variantId: h.variant_id });
}

// ---------------------------------------------------------------------------
// Place

export interface PlaceInput {
  expectedVersion: number;
  expectedTotalMinor: number;
  clientRequestId: string;
  /**
   * The repeat-purchase consent checkbox (Phase 9 D13): true only when the
   * customer ticked it. Undefined (an older client) records nothing, which
   * reads as unknown and never sends.
   */
  marketingOptIn?: boolean;
}

export interface PlaceResult {
  orderId: string;
  /** False when the session had already placed this order (a replay). */
  created: boolean;
}

/**
 * Place the session's order (E6). Worker role, after the public route resolved
 * the token. Throws StoreError with a refusal code: checkout_disabled,
 * store_not_configured, conflict (stale version), address_required,
 * quote_changed (with the new quote), out_of_stock (with the variant),
 * too_many_open_orders (a contact hold cap), coupon_*, and every pricing refusal. A replay returns the order the session
 * already placed.
 */
export async function placeOrder(accountId: string, sessionId: string, input: PlaceInput, now = new Date()): Promise<PlaceResult> {
  if (!isUuid(sessionId) || !isUuid(input.clientRequestId) || !Number.isInteger(input.expectedVersion)
    || !Number.isSafeInteger(input.expectedTotalMinor) || input.expectedTotalMinor < 0
    || (input.marketingOptIn !== undefined && typeof input.marketingOptIn !== 'boolean')) throw new StoreError('invalid');
  const optIn = input.marketingOptIn ?? null;
  const optInAt = optIn === null ? null : now;
  const optInVersion = optIn === null ? null : MARKETING_OPT_IN_VERSION;
  return worker(accountId, async (tx) => {
    const session = await loadSession(tx, accountId, sessionId, true);
    if (!session || session.revoked_at) throw new StoreError('not_found');
    if (session.order_id) {
      const placed = await loadOrder(tx, accountId, session.order_id);
      if (placed?.priced_at) return { orderId: placed.id, created: false };
    }
    if (session.purpose === 'status') throw new StoreError('cart_locked');
    assertOpen(session, now);
    await requireFeature(tx, accountId, 'storefront');
    await requireSendingAllowed(tx, accountId);
    const settings = await loadPricingSettings(tx, accountId);
    if (!settings) throw new StoreError('store_not_configured');
    if (!settings.checkout_enabled) throw new StoreError('checkout_disabled');
    if (session.version !== input.expectedVersion) throw new StoreError('conflict');
    if (!session.address) throw new StoreError('address_required');
    // Before the order row (lock order): the contact's holds are counted under its advisory lock.
    await lockContactHoldsTx(tx, accountId, session.contact_id, session.order_id, now);

    // A WhatsApp cart: its order row is locked before the coupon (lock order).
    let existing = null;
    if (session.purpose === 'order') {
      if (!session.order_id) throw new StoreError('order_not_open');
      existing = await loadOrder(tx, accountId, session.order_id, true);
      if (!existing || existing.priced_at || existing.source !== 'whatsapp' || !['new', 'confirmed'].includes(existing.status))
        throw new StoreError('order_not_open');
    }
    const coupon = session.coupon_code ? await lockCouponTx(tx, accountId, session.coupon_code) : null;
    const { result } = await quoteSessionTx(tx, accountId, session, { lockedCoupon: coupon, now });
    if (!result.ok) throw new StoreError(result.code, 'variantId' in result && result.variantId ? { variantId: result.variantId } : undefined);
    const quote = result.quote;
    if (!quote.shipping) throw new StoreError('address_required');
    if (quote.totalMinor !== input.expectedTotalMinor) throw new StoreError('quote_changed', { quote });
    const stockLines = quote.lines.filter((l) => l.trackInventory).map((l) => ({ variantId: l.variantId, quantity: l.qty }));
    await assertVariantHoldsTx(tx, accountId, session.contact_id, stockLines, now);

    const orderId = existing?.id ?? randomUUID();
    const address = JSON.stringify(session.address);
    if (!existing) {
      await tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,
          discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,coupon_code,shipping_address,storefront_session_id,status,
          marketing_opt_in,marketing_opt_in_at,marketing_opt_in_version)
        VALUES(${orderId}::uuid,${accountId}::uuid,'storefront',${session.contact_id}::uuid,${session.conversation_id}::uuid,
          ${session.whatsapp_config_id}::uuid,${quote.currency},${quote.subtotalMinor},${quote.discountMinor},${quote.shippingMinor},
          ${quote.taxMinor},${quote.taxInclusive},${quote.totalMinor},${quote.couponCode},${address}::jsonb,${session.id}::uuid,'new',
          ${optIn}::boolean,${optInAt}::timestamptz,${optInVersion}::text)`;
      for (const line of quote.lines) {
        const options = Object.values(line.optionValues).filter(Boolean).join(' / ');
        const name = (options ? `${line.productName} (${options})` : line.productName).slice(0, 500);
        await tx.$executeRaw`INSERT INTO order_items(account_id,order_id,retailer_id,name,quantity,unit_price_minor,currency,variant_id,
            tax_rate_bps,tax_minor,discount_minor,line_total_minor,hsn_code,sku)
          VALUES(${accountId}::uuid,${orderId}::uuid,${line.sku},${name},${line.qty},${line.unitPriceMinor},${quote.currency},
            ${line.variantId}::uuid,${line.taxRateBps},${line.taxMinor},${line.discountMinor},${line.lineTotalMinor},${line.hsnCode},${line.sku})`;
      }
    } else {
      // Reprice the cart's own lines by SKU; the Meta price is kept only as what the customer was shown.
      const items = await tx.$queryRaw<{ id: string; key: string | null; unit_price_minor: bigint; quantity: number }[]>`
        SELECT id::text AS id, COALESCE(sku, retailer_id) AS key, unit_price_minor, quantity FROM order_items
        WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid ORDER BY id`;
      const bySku = new Map(quote.lines.map((l) => [l.sku, l]));
      if (new Set(items.map((i) => i.key)).size !== items.length) throw new StoreError('invalid_cart');
      for (const item of items) {
        const line = item.key ? bySku.get(item.key) : undefined;
        if (!line || line.qty !== item.quantity) throw new StoreError('price_not_configured');
        await tx.$executeRaw`UPDATE order_items SET variant_id=${line.variantId}::uuid,sku=${line.sku},
            submitted_unit_price_minor=${minorFromDb(item.unit_price_minor)},unit_price_minor=${line.unitPriceMinor},currency=${quote.currency},
            tax_rate_bps=${line.taxRateBps},tax_minor=${line.taxMinor},discount_minor=${line.discountMinor},
            line_total_minor=${line.lineTotalMinor},hsn_code=${line.hsnCode}
          WHERE account_id=${accountId}::uuid AND id=${item.id}::uuid`;
      }
      await tx.$executeRaw`UPDATE orders SET currency=${quote.currency},subtotal_minor=${quote.subtotalMinor},discount_minor=${quote.discountMinor},
          shipping_minor=${quote.shippingMinor},tax_minor=${quote.taxMinor},tax_inclusive=${quote.taxInclusive},total_minor=${quote.totalMinor},
          coupon_code=${quote.couponCode},shipping_address=${address}::jsonb,storefront_session_id=${session.id}::uuid,
          marketing_opt_in=${optIn}::boolean,marketing_opt_in_at=${optInAt}::timestamptz,marketing_opt_in_version=${optInVersion}::text
        WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    }

    if (coupon) await redeemCouponTx(tx, accountId, { coupon, orderId, contactId: session.contact_id });
    const expiresAt = new Date(now.getTime() + settings.reservation_minutes * 60_000);
    try {
      await reserveTx(tx, accountId, orderId, stockLines, expiresAt);
    } catch (error) {
      if (error instanceof StockError && error.code === 'out_of_stock') throw new StoreError('out_of_stock', { variantId: error.variantId });
      throw error;
    }
    const attempt = (existing?.checkout_attempt ?? 0) + 1;
    await tx.$executeRaw`UPDATE orders SET priced_at=${now},status='awaiting_payment',reservation_expires_at=${expiresAt},checkout_attempt=${attempt}
      WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    await orderEvent(tx, accountId, orderId, 'priced', 'customer');
    await orderEvent(tx, accountId, orderId, 'reserved', 'system');
    await tx.$executeRaw`UPDATE storefront_sessions SET order_id=${orderId}::uuid, version=version+1
      WHERE account_id=${accountId}::uuid AND id=${session.id}::uuid`;
    await enqueue(tx, accountId, CHECKOUT_JOB_TYPES.reservationExpiry, { orderId, attempt }, `resv-exp:${orderId}:${attempt}`,
      new Date(expiresAt.getTime() + 60_000));
    await enqueue(tx, accountId, CHECKOUT_JOB_TYPES.createCheckoutLink, { orderId, attempt }, `colink:${orderId}:${attempt}`);
    return { orderId, created: true };
  });
}

// ---------------------------------------------------------------------------
// Jobs

/**
 * Release the stock and coupon of an order still awaiting payment with no
 * settled payment, set it expired and cancel its link. Idempotent: anything
 * else (paid, cancelled, a later attempt) is left alone.
 */
export async function expireReservation(accountId: string, payload: ReservationExpiryJobPayload): Promise<void> {
  if (!isUuid(payload.orderId) || !Number.isInteger(payload.attempt)) throw new Error('Invalid reservation expiry job contract');
  await worker(accountId, async (tx) => {
    const order = await loadOrder(tx, accountId, payload.orderId, true);
    if (!order || order.status !== 'awaiting_payment' || order.checkout_attempt !== payload.attempt || !order.reservation_expires_at) return;
    const settled = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_payments
      WHERE account_id=${accountId}::uuid AND order_id=${order.id}::uuid AND settlement='settled'`;
    if ((settled[0]?.n ?? 0) > 0) return;
    if (order.reservation_expires_at.getTime() > Date.now()) {
      // Ran early (clock skew): look again when the hold really ends.
      await enqueue(tx, accountId, CHECKOUT_JOB_TYPES.reservationExpiry, payload,
        `resv-exp:${order.id}:${payload.attempt}:${order.reservation_expires_at.getTime()}`, new Date(order.reservation_expires_at.getTime() + 60_000));
      return;
    }
    await releaseTx(tx, accountId, order.id, 'expired');
    await releaseCouponTx(tx, accountId, order.id);
    await tx.$executeRaw`UPDATE orders SET status='expired' WHERE account_id=${accountId}::uuid AND id=${order.id}::uuid`;
    await orderEvent(tx, accountId, order.id, 'released', 'system', 'expired');
    await cancelLiveLinksTx(tx, accountId, order.id);
  });
}

/** Queue the existing payments.cancel_link job for the order's unpaid links. */
async function cancelLiveLinksTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    SELECT 'payments.cancel_link', l.account_id, jsonb_build_object('linkId', l.id::text), 'payment-link-cancel:' || l.id::text
    FROM payment_links l WHERE l.account_id=${accountId}::uuid AND l.order_id=${orderId}::uuid AND l.status='created'
    ON CONFLICT (dedupe_key) DO NOTHING`;
}

/** The storefront token of the session that placed (or is bound to) an order, or null. */
async function orderSessionToken(tx: TenantTransaction, accountId: string, orderId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ id: string; token_epoch: number }[]>`SELECT id::text AS id, token_epoch FROM storefront_sessions
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND purpose<>'status' AND revoked_at IS NULL LIMIT 1`;
  return row ? deriveStorefrontToken(row.id, row.token_epoch) : null;
}

/**
 * Create the order's payment link (reference co_..., expireBy = max(hold end,
 * now + 16 min)) unless it is no longer awaiting payment or already has a live
 * link. The storefront page opens the link itself (it polls the order), so no
 * WhatsApp message is sent here. A definite refusal (no Razorpay connection,
 * provider refusal) leaves the order awaiting payment until its hold expires;
 * an ambiguous create throws so the job retries, and the retry reconciles the
 * same reference instead of creating a second link.
 */
export async function createCheckoutLinkJob(accountId: string, payload: CheckoutLinkJobPayload): Promise<void> {
  if (!isUuid(payload.orderId) || !Number.isInteger(payload.attempt)) throw new Error('Invalid checkout link job contract');
  const plan = await worker(accountId, async (tx) => {
    const order = await loadOrder(tx, accountId, payload.orderId);
    if (!order || order.status !== 'awaiting_payment' || order.checkout_attempt !== payload.attempt || !order.priced_at) return null;
    const due = (minorFromDb(order.total_minor) ?? 0) - (minorFromDb(order.amount_paid_minor) ?? 0);
    if (due <= 0) return null;
    const token = await orderSessionToken(tx, accountId, order.id);
    const holdEnd = order.reservation_expires_at?.getTime() ?? 0;
    return {
      order, due, expireBy: new Date(Math.max(holdEnd, Date.now() + MIN_LINK_MINUTES * 60_000)),
      callbackUrl: token ? `${storefrontUrl(token)}/done` : null,
    };
  });
  if (!plan) return;
  const reference = checkoutPaymentReference(plan.order.id, payload.attempt);
  try {
    const { outcome } = await createPaymentLinkRecord({
      accountId, actor: { kind: 'bot' }, amountMinor: plan.due, currency: plan.order.currency,
      description: getT('Storefront.payment')('linkDescription', { reference: orderReference(plan.order.id) }),
      contactId: plan.order.contact_id, conversationId: plan.order.conversation_id, orderId: plan.order.id,
      expireBy: plan.expireBy, referenceId: reference, callbackUrl: plan.callbackUrl,
    });
    if (outcome === 'unknown') throw new Error('Checkout link outcome unknown; retry reconciles the reference');
  } catch (error) {
    if (error instanceof PaymentLinkError && !['provider_unreachable', 'busy'].includes(error.code)) {
      console.error('[checkout] link refused', error.code);
      return;
    }
    throw error;
  }
  // The hold may have ended while the link was being created: cancel it rather than leave it payable.
  await worker(accountId, async (tx) => {
    const order = await loadOrder(tx, accountId, plan.order.id);
    if (order && order.status !== 'awaiting_payment') await cancelLiveLinksTx(tx, accountId, order.id);
  });
}

type MessageOutcome = { status: 'sent' | 'skipped' | 'blocked' | 'failed' | 'outcome_unknown'; reason: string | null };

async function settleOrderMessage(accountId: string, orderId: string, outcome: MessageOutcome): Promise<void> {
  await worker(accountId, (tx) => tx.$executeRaw`INSERT INTO order_messages(account_id,order_id,kind,status,reason)
    VALUES(${accountId}::uuid,${orderId}::uuid,'checkout_link',${outcome.status},${outcome.reason})
    ON CONFLICT (account_id,order_id,kind) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_at=now()
    WHERE order_messages.resolved_at IS NULL`);
}

/**
 * Issue a purpose='order' storefront session for a WhatsApp cart and send the
 * checkout link once (dispatchOnce('order:<id>:checkout_link')): a text inside
 * the window, otherwise the store's checkout template ({{1}} the link, {{2}}
 * the order reference). Every refusal is decided before the send and recorded
 * in order_messages; an ambiguous send is recorded outcome_unknown and never
 * repeated.
 */
export async function prepareWhatsAppOrderJob(accountId: string, payload: PrepareWhatsAppOrderJobPayload): Promise<void> {
  if (!isUuid(payload.orderId)) throw new Error('Invalid prepare order job contract');
  const orderId = payload.orderId;
  const intentKey = `order:${orderId}:checkout_link`;
  type Plan =
    | { kind: 'done' }
    | { kind: 'settle'; outcome: MessageOutcome; uncertain?: boolean }
    | { kind: 'send'; contactId: string; conversationId: string | null; url: string; reference: string; windowOpen: boolean;
      template: { name: string; language: string | null; body: string } | null };
  const plan = await worker(accountId, async (tx): Promise<Plan> => {
    const order = await loadOrder(tx, accountId, orderId);
    if (!order) return { kind: 'done' };
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`SELECT status, resolved_at FROM order_messages
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='checkout_link'`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };
    const [intent] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM outbound_intents
      WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${intentKey}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return { kind: 'settle', outcome: { status: 'failed', reason: 'provider_rejected' } };
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    if (order.source !== 'whatsapp' || order.priced_at || !['new', 'confirmed'].includes(order.status))
      return { kind: 'settle', outcome: { status: 'skipped', reason: 'order_not_open' } };
    if (!order.contact_id) return { kind: 'settle', outcome: { status: 'skipped', reason: 'contact_missing' } };
    try {
      await requireFeature(tx, accountId, 'storefront');
    } catch {
      return { kind: 'settle', outcome: { status: 'skipped', reason: 'feature_unavailable' } };
    }
    const settings = await loadPricingSettings(tx, accountId);
    if (!settings?.checkout_enabled) return { kind: 'settle', outcome: { status: 'skipped', reason: 'checkout_disabled' } };
    const [contact] = await tx.$queryRaw<{ blocked_at: Date | null }[]>`SELECT blocked_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${order.contact_id}::uuid`;
    if (!contact) return { kind: 'settle', outcome: { status: 'skipped', reason: 'contact_missing' } };
    if (contact.blocked_at) return { kind: 'settle', outcome: { status: 'skipped', reason: 'contact_blocked' } };
    // No link for a contact already at the open-order cap: placing it would be refused anyway.
    if (await openOrderCountTx(tx, accountId, order.contact_id, orderId, new Date()) >= CONTACT_HOLD_LIMITS.openOrders)
      return { kind: 'settle', outcome: { status: 'skipped', reason: 'too_many_open_orders' } };
    if (await isSuspended(tx, accountId)) return { kind: 'settle', outcome: { status: 'blocked', reason: 'workspace_suspended' } };

    // Reuse the order's session (a retried job) or issue it, valid 24 h.
    const [session] = await tx.$queryRaw<{ id: string; token_epoch: number }[]>`SELECT id::text AS id, token_epoch FROM storefront_sessions
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND purpose='order' AND revoked_at IS NULL`;
    let url: string;
    if (session) url = storefrontUrl(deriveStorefrontToken(session.id, session.token_epoch));
    else url = (await issueSessionTx(tx, accountId, {
      sessionId: seededUuid(`storefront:order:${accountId}:${orderId}`), contactId: order.contact_id,
      conversationId: order.conversation_id, whatsappConfigId: order.whatsapp_config_id, purpose: 'order', orderId,
      ttlHours: STOREFRONT_TTL.defaultHours, createdBy: null,
    })).url;

    const [conversation] = order.conversation_id ? await tx.$queryRaw<{ last_customer_at: Date | null }[]>`
      SELECT (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_at
      FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.id=${order.conversation_id}::uuid` : [];
    const last = conversation?.last_customer_at ? new Date(conversation.last_customer_at).getTime() : NaN;
    const windowOpen = Number.isFinite(last) && Date.now() - last < OPEN_WINDOW_MS;
    let template: { name: string; language: string | null; body: string } | null = null;
    if (!windowOpen) {
      if (!settings.checkout_template_name) return { kind: 'settle', outcome: { status: 'blocked', reason: 'no_template' } };
      const [row] = await tx.$queryRaw<{ name: string; language: string | null; status: string | null; category: string | null; body_text: string | null }[]>`
        SELECT name, language, status, category, body_text FROM message_templates
        WHERE account_id=${accountId}::uuid AND name=${settings.checkout_template_name}
          AND (${settings.checkout_template_language}::text IS NULL OR lower(language)=lower(${settings.checkout_template_language}::text))
        ORDER BY (upper(coalesce(status,''))='APPROVED') DESC, language LIMIT 1`;
      if (!row) return { kind: 'settle', outcome: { status: 'blocked', reason: 'template_not_found' } };
      if (String(row.status ?? '').toUpperCase() !== 'APPROVED') return { kind: 'settle', outcome: { status: 'blocked', reason: 'template_not_approved' } };
      // A checkout link is a service message: never a MARKETING template.
      if (String(row.category ?? '').toUpperCase() !== 'UTILITY') return { kind: 'settle', outcome: { status: 'blocked', reason: 'category' } };
      template = { name: row.name, language: row.language, body: row.body_text ?? '' };
    }
    return { kind: 'send', contactId: order.contact_id, conversationId: order.conversation_id, url, reference: orderReference(orderId), windowOpen, template };
  });

  if (plan.kind === 'done') return;
  if (plan.kind === 'settle') {
    await settleOrderMessage(accountId, orderId, plan.outcome);
    if (plan.uncertain) throw new UncertainDispatchError();
    return;
  }
  try {
    if (!plan.template) {
      await sendStorefrontText({
        accountId, contactId: plan.contactId, conversationId: plan.conversationId, intentKey,
        text: linkMessageText(getT('Storefront.payment')('checkoutMessage', { reference: plan.reference }), plan.url),
        sender: { kind: 'bot', service: true },
      });
    } else {
      if (!plan.conversationId) {
        await settleOrderMessage(accountId, orderId, { status: 'failed', reason: 'no_conversation' });
        return;
      }
      const template = plan.template;
      const db = createAdminClient({ accountId, role: 'owner' });
      const userId = await resolveAuditUserId(db, accountId);
      const indices = extractVariableIndices(template.body);
      const count = indices.length ? Math.max(...indices) : 0;
      const values = [plan.url, plan.reference];
      const params = Array.from({ length: count }, (_, i) => values[i] ?? '-');
      await dispatchOnce(accountId, intentKey, () => engineSendTemplate({
        accountId, userId, conversationId: plan.conversationId!, contactId: plan.contactId, templateName: template.name,
        language: template.language ?? undefined, params, bodyValuesOnly: true, serviceMessage: true,
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await settleOrderMessage(accountId, orderId, { status: 'outcome_unknown', reason: 'uncertain' });
      throw error;
    }
    if (error instanceof StoreError) {
      await settleOrderMessage(accountId, orderId, { status: error.code === 'outside_window' ? 'blocked' : 'failed', reason: error.code });
      return;
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      await settleOrderMessage(accountId, orderId, { status: 'failed', reason: 'provider_rejected' });
      return;
    }
    throw error;
  }
  await settleOrderMessage(accountId, orderId, { status: 'sent', reason: null });
}
