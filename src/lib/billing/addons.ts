// Add-on purchases: extra AI messages, seats or WhatsApp numbers on top of the
// plan, charged through the platform billing provider as a one-time add-on on
// the subscription's next invoice. Server only.
//
// Packs are configured in BILLING_ADDON_PRICES, a JSON array of
//   { "kind": "ai_messages" | "extra_seats" | "extra_numbers",
//     "quantity": units per pack, "amount_minor": price per pack in paise excl. GST,
//     "currency"?: "INR" (the only currency: subscriptions and invoices are INR) }
//
// GST: the pack price excludes GST (the UI says "+ GST"). The provider is
// charged the pack price plus the buyer's GST for their place of supply (none
// for an export), because invoices.ts treats every charge as GST-inclusive and
// splits the tax out of it. add_ons.amount_minor records that charged amount.
//
// What a purchase covers:
//   ai_messages    the rest of the current usage month (India time)
//   extra_seats, extra_numbers  the rest of the current billing period
// It is not renewed automatically; buy again for the next period.
//
// Durability: the add-on row is written as 'pending' BEFORE the provider is
// called, with provider_marker set: the provider call carries the row's id
// (findAddon matches it). ok -> 'active' (raises the limit); rejected ->
// 'failed'; unknown -> stays 'pending' and is never retried or granted here.
// A second purchase of the same kind is refused while one is pending (for its
// first day, while the sweep settles it), so a retry cannot charge twice for
// one grant; after that an operator item is open and buying is allowed again. The billing lifecycle sweep
// (reconcilePendingAddons, audit finding 53) asks the provider for the add-on
// by its id: found -> 'active'; the provider has none an hour on -> 'failed'
// (nothing was charged); still unclear a day on -> a billing reconciliation
// item for an operator. Nothing is granted without the provider's add-on.

import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { ADDON_KINDS, ADDON_LIMIT, type AddonKind } from './entitlements-catalogue';
import { getEntitlements } from './entitlements';
import { openReconciliationItem } from './reconciliation';
import { computeGst, sellerStateCode } from './gst';
import { invoiceBuyer } from './invoices';
import type { BillingProvider } from './provider';

export interface AddonPack {
  kind: AddonKind;
  /** Units one pack adds (messages, seats or numbers). */
  quantity: number;
  /** Price of one pack in minor units, excluding GST. */
  amountMinor: number;
  currency: string;
}

export type AddonStatus = 'pending' | 'active' | 'cancelled' | 'failed';

/** An add-on as admins see it (never the provider's ids). */
export interface AddonView {
  id: string;
  kind: AddonKind;
  quantity: number;
  status: AddonStatus;
  amountMinor: number | null;
  currency: string | null;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

/** A refusal that is safe to show; `code` picks the message. */
export class AddonInputError extends Error {
  constructor(public code: 'unknown_pack' | 'invalid_packs' | 'needs_subscription' | 'not_cancellable' | 'limit_unlimited' | 'purchase_pending', public status = 400) {
    super(code);
  }
}

export const MAX_PACKS = 100;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The configured packs. Invalid entries are dropped, as is a second pack of the same kind. */
export function addonPacks(env: Record<string, string | undefined> = process.env): AddonPack[] {
  const raw = env.BILLING_ADDON_PRICES;
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const packs: AddonPack[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const { kind, quantity, amount_minor: amountMinor, currency = 'INR' } = entry as Record<string, unknown>;
    if (!ADDON_KINDS.includes(kind as AddonKind) || packs.some((p) => p.kind === kind)) continue;
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0 || (quantity as number) > 1_000_000) continue;
    if (!Number.isSafeInteger(amountMinor) || (amountMinor as number) <= 0) continue;
    if (currency !== 'INR') continue;
    packs.push({ kind: kind as AddonKind, quantity: quantity as number, amountMinor: amountMinor as number, currency });
  }
  return packs;
}

/** Validates a purchase body { kind, packs }. */
export function parsePurchase(body: unknown, packs: AddonPack[]): { pack: AddonPack; packs: number } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const pack = packs.find((p) => p.kind === input.kind);
  if (!pack) throw new AddonInputError('unknown_pack');
  const count = input.packs ?? 1;
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > MAX_PACKS) throw new AddonInputError('invalid_packs');
  if (pack.quantity * (count as number) > 1_000_000) throw new AddonInputError('invalid_packs');
  return { pack, packs: count as number };
}

export async function listAddons(tx: TenantTransaction, accountId: string): Promise<AddonView[]> {
  const rows = await tx.$queryRaw<{ id: string; kind: AddonKind; quantity: number; status: AddonStatus; amount_minor: bigint | null;
    currency: string | null; starts_at: Date; ends_at: Date | null; created_at: Date }[]>`
    SELECT id::text, kind, quantity, status, amount_minor, currency, starts_at, ends_at, created_at FROM add_ons
    WHERE account_id=${accountId}::uuid ORDER BY created_at DESC, id LIMIT 100`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, quantity: r.quantity, status: r.status,
    amountMinor: r.amount_minor === null ? null : Number(r.amount_minor), currency: r.currency,
    startsAt: r.starts_at.toISOString(), endsAt: r.ends_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
  }));
}

interface BillableSubscription { providerSubscriptionId: string; periodEnd: Date | null }

/** The provider subscription an add-on can be charged to: active or trialing, with an id. */
export async function billableSubscription(tx: TenantTransaction, accountId: string, provider: string): Promise<BillableSubscription | null> {
  const [row] = await tx.$queryRaw<{ provider_subscription_id: string | null; current_period_end: Date | null }[]>`
    SELECT provider_subscription_id, current_period_end FROM account_subscriptions
    WHERE account_id=${accountId}::uuid AND provider=${provider} AND status IN ('active','trialing') AND provider_subscription_id IS NOT NULL`;
  return row?.provider_subscription_id ? { providerSubscriptionId: row.provider_subscription_id, periodEnd: row.current_period_end } : null;
}

const ADDON_NAMES: Record<AddonKind, string> = { ai_messages: 'AI messages', extra_seats: 'Team seats', extra_numbers: 'WhatsApp numbers' };

export interface PurchaseArgs {
  accountId: string;
  userId: string;
  pack: AddonPack;
  packs: number;
}

/** What one pack is charged: its price plus the buyer's GST (none for an export). */
export async function packChargeMinor(tx: TenantTransaction, accountId: string, pack: AddonPack, seller: string): Promise<number> {
  const buyer = await invoiceBuyer(tx, accountId, seller);
  const gst = computeGst({ amountMinor: pack.amountMinor, sellerStateCode: seller, buyerStateCode: buyer.stateCode, buyerCountry: buyer.country });
  return pack.amountMinor + gst.tax;
}

/**
 * Records the purchase as pending, asks the provider to add the charge, then
 * settles the row from the provider's answer. Returns the add-on's status:
 * 'active', 'failed' or 'pending' (unknown outcome, awaiting reconciliation).
 */
export async function purchaseAddon(provider: BillingProvider, args: PurchaseArgs, db: PrismaClient = getWorkerPrisma()):
  Promise<{ id: string; status: AddonStatus }> {
  const { accountId, userId, pack, packs } = args;
  const scope = { accountId, userId };
  const seller = sellerStateCode();
  // The route refuses earlier; without the seller's state no GST can be added or invoiced.
  if (!seller) throw new Error('BILLING_SELLER_STATE_CODE is not set');
  const intent = await withTenant(scope, async (tx) => {
    const subscription = await billableSubscription(tx, accountId, provider.name);
    if (!subscription) throw new AddonInputError('needs_subscription', 409);
    // A pack raises a finite limit; on an unlimited one the buyer would pay for nothing.
    if ((await getEntitlements(tx, accountId)).limits[ADDON_LIMIT[pack.kind]] === null) throw new AddonInputError('limit_unlimited', 409);
    // Seats and numbers last for the billing period they are charged in.
    if (pack.kind !== 'ai_messages' && !(subscription.periodEnd && subscription.periodEnd.getTime() > Date.now()))
      throw new AddonInputError('needs_subscription', 409);
    // One unconfirmed purchase per kind: a retry while the provider's answer is unclear could charge twice.
    // Only while the sweep is still settling it automatically: once an operator item is open (a day on, or a
    // row from before the marker existed) the workspace is not locked out of buying until someone edits the row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:add_on:${pack.kind}`}))`;
    const [pending] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM add_ons
      WHERE account_id=${accountId}::uuid AND kind=${pack.kind} AND status='pending' AND provider_marker
        AND created_at > ${new Date(Date.now() - ADDON_OPERATOR_AFTER_MS)}`;
    if ((pending?.n ?? 0) > 0) throw new AddonInputError('purchase_pending', 409);
    const unitMinor = await packChargeMinor(tx, accountId, pack, seller);
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO add_ons(account_id, kind, quantity, status, amount_minor, currency, requested_by, provider_marker)
      VALUES (${accountId}::uuid, ${pack.kind}, ${pack.quantity * packs}, 'pending', ${unitMinor * packs}, ${pack.currency}, ${userId}::uuid, true)
      RETURNING id::text`;
    return { id: row.id, subscription, unitMinor };
  }, db);

  const result = await provider.createAddon({
    subscriptionId: intent.subscription.providerSubscriptionId,
    name: `${ADDON_NAMES[pack.kind]} (${pack.quantity.toLocaleString('en')})`,
    amountMinor: intent.unitMinor,
    currency: pack.currency,
    quantity: packs,
    reference: intent.id,
  });
  if (result.outcome === 'unknown') return { id: intent.id, status: 'pending' };

  return withTenant(scope, async (tx) => {
    if (result.outcome === 'rejected') {
      await tx.$executeRaw`UPDATE add_ons SET status='failed' WHERE id=${intent.id}::uuid AND status='pending'`;
      return { id: intent.id, status: 'failed' as const };
    }
    // Not activated (its period ended while the provider answered): it stays pending for the sweep and an operator.
    if (!(await activateAddon(tx, intent.id, result.value.id, intent.subscription.periodEnd))) return { id: intent.id, status: 'pending' as const };
    return { id: intent.id, status: 'active' as const };
  }, db);
}

/**
 * Marks a pending add-on active from the provider's add-on id. ai_messages: until
 * the IST month it was bought in ends; others: until the billing period ends.
 * Returns false (nothing changed) when it is no longer pending or that end has passed.
 */
async function activateAddon(tx: TenantTransaction, id: string, providerAddonId: string, periodEnd: Date | null): Promise<boolean> {
  const updated = await tx.$executeRaw`UPDATE add_ons SET status='active', provider_addon_id=${providerAddonId}, starts_at=now(),
    ends_at = CASE WHEN kind='ai_messages'
      THEN (date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') + interval '1 month') AT TIME ZONE 'Asia/Kolkata'
      ELSE ${periodEnd}::timestamptz END
    WHERE id=${id}::uuid AND status='pending'
      AND CASE WHEN kind='ai_messages'
        THEN (date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') + interval '1 month') AT TIME ZONE 'Asia/Kolkata'
        ELSE ${periodEnd}::timestamptz END > now()`;
  return updated > 0;
}

/** Pending add-ons are first asked about this long after the purchase began (a provider call times out after 15 s). */
export const ADDON_RECONCILE_AFTER_MS = 2 * 60_000;
/** The provider showing no add-on this long after the purchase began means it was never created. */
export const ADDON_ABSENT_AFTER_MS = 60 * 60_000;
/** Still pending this long after the purchase: an operator looks (billing reconciliation item). */
export const ADDON_OPERATOR_AFTER_MS = 24 * 3_600_000;

/**
 * Settles add-ons whose provider answer was lost (part of billing.lifecycle_sweep).
 * The provider's own add-on, matched by our id, is the only proof that grants one;
 * an add-on the provider does not have an hour on is failed (nothing was charged).
 * Anything still pending a day on gets one billing reconciliation item.
 */
export async function reconcilePendingAddons(accountId: string, provider: BillingProvider, now: Date = new Date(), db: PrismaClient = getWorkerPrisma()): Promise<void> {
  const scope = { accountId, role: 'owner' as const };
  const rows = await withTenant(scope, (tx) => tx.$queryRaw<{ id: string; created_at: Date }[]>`
    SELECT id::text, created_at FROM add_ons
    WHERE account_id=${accountId}::uuid AND status='pending' AND provider_marker
      AND created_at < ${new Date(now.getTime() - ADDON_RECONCILE_AFTER_MS)}
    ORDER BY created_at LIMIT 20`, db);
  for (const row of rows) {
    const found = await provider.findAddon({ reference: row.id, createdAfter: row.created_at });
    if (found.outcome !== 'ok') continue;
    const value = found.value;
    await withTenant(scope, async (tx) => {
      if (value) {
        const subscription = await billableSubscription(tx, accountId, provider.name);
        if (await activateAddon(tx, row.id, value.id, subscription?.periodEnd ?? null)) return;
        // The provider has it, but the period it was bought for is over (or the subscription is gone): an operator decides.
        await openReconciliationItem(tx, { accountId, kind: 'intent_unknown', sourceRef: `addon:${row.id}`,
          detail: { object: 'add_on', add_on_id: row.id, provider_addon_id: value.id, reason: 'period_over', created_at: row.created_at.toISOString() } });
      } else if (now.getTime() - row.created_at.getTime() > ADDON_ABSENT_AFTER_MS) {
        await tx.$executeRaw`UPDATE add_ons SET status='failed' WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND status='pending'`;
      }
    }, db);
  }
  await withTenant(scope, async (tx) => {
    const stale = await tx.$queryRaw<{ id: string; kind: string; quantity: number; amount_minor: bigint | null; currency: string | null; created_at: Date }[]>`
      SELECT id::text, kind, quantity, amount_minor, currency, created_at FROM add_ons
      WHERE account_id=${accountId}::uuid AND status='pending' AND created_at < ${new Date(now.getTime() - ADDON_OPERATOR_AFTER_MS)}`;
    for (const a of stale)
      await openReconciliationItem(tx, { accountId, kind: 'intent_unknown', sourceRef: `addon:${a.id}`, detail: {
        object: 'add_on', add_on_id: a.id, add_on_kind: a.kind, quantity: a.quantity,
        amount_minor: a.amount_minor === null ? null : Number(a.amount_minor), currency: a.currency,
        created_at: a.created_at.toISOString(), reason: 'unconfirmed' } });
  }, db);
}

/**
 * Stops an active add-on now. The provider charge already added to the next
 * invoice is not reversed (no refund); the UI says so before confirming.
 */
export async function cancelAddon(accountId: string, userId: string, id: string, db: PrismaClient = getWorkerPrisma()): Promise<void> {
  if (!uuid.test(id)) throw new AddonInputError('not_cancellable', 404);
  const updated = await withTenant({ accountId, userId }, (tx) => tx.$executeRaw`
    UPDATE add_ons SET status='cancelled', ends_at=GREATEST(now(), starts_at + interval '1 millisecond')
    WHERE account_id=${accountId}::uuid AND id=${id}::uuid AND status='active'`, db);
  if (!updated) throw new AddonInputError('not_cancellable', 409);
}
