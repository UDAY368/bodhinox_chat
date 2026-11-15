/**
 * Store plan Phase 3, package 2: the pure rules and the queueing for the
 * abandoned-cart reminder and the COD confirmation. No provider calls here
 * (the jobs and the inbound reply are in cart-followup-jobs.ts), so storefront
 * and checkout can import this without a cycle.
 *
 * - Abandoned cart: when a shop session first gets items and the store has a
 *   delay set, one commerce.abandoned_cart job is queued (dedupe abandon:<id>).
 * - COD confirmation: a placed COD order whose store asks for it starts
 *   'pending' and queues one commerce.cod_confirm job (dedupe cod_confirm:<id>).
 *   The customer's tap on the Yes / Cancel button carries codc:<orderId>:yes|no.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

export const ABANDONED_DELAY_MINUTES = { min: 30, max: 2880 } as const;

export const ABANDONED_CART_JOB = 'commerce.abandoned_cart';
export const COD_CONFIRM_JOB = 'commerce.cod_confirm';

export type CodConfirmation = 'pending' | 'confirmed' | 'declined';
export const COD_CONFIRMATIONS: readonly CodConfirmation[] = ['pending', 'confirmed', 'declined'];
export const isCodConfirmation = (value: unknown): value is CodConfirmation =>
  typeof value === 'string' && (COD_CONFIRMATIONS as readonly string[]).includes(value);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const COD_REPLY = new RegExp(`^codc:(${UUID}):(yes|no)$`, 'i');

export const codConfirmButtonId = (orderId: string, choice: 'yes' | 'no') => `codc:${orderId}:${choice}`;

/** The order and answer of a COD confirmation button id, or null for any other reply id. */
export function parseCodConfirmReply(replyId: unknown): { orderId: string; choice: 'yes' | 'no' } | null {
  if (typeof replyId !== 'string' || replyId.length > 64) return null;
  const match = COD_REPLY.exec(replyId);
  return match ? { orderId: match[1].toLowerCase(), choice: match[2].toLowerCase() as 'yes' | 'no' } : null;
}

/** Only a pending confirmation can be answered; the answer then stands (a replay or a second tap changes nothing). */
export function codTransition(current: string | null, choice: 'yes' | 'no'): 'confirmed' | 'declined' | null {
  return current === 'pending' ? (choice === 'yes' ? 'confirmed' : 'declined') : null;
}

/** The state a COD order starts in when it is placed: pending only for a COD order of a store that asks. */
export function initialCodConfirmation(paymentMethod: string, storeAsks: boolean): 'pending' | null {
  return paymentMethod === 'cod' && storeAsks ? 'pending' : null;
}

export interface AbandonedCartFacts {
  /** The store's setting right now (null = off). */
  delayMinutes: number | null;
  checkoutEnabled: boolean;
  purpose: string;
  revoked: boolean;
  expired: boolean;
  orderId: string | null;
  cartLines: number;
  remindedAt: Date | null;
}

/** Why the reminder no longer applies to the session (a code), or null when it should go. */
export function abandonedCartSkip(f: AbandonedCartFacts): string | null {
  if (f.remindedAt) return 'already_reminded';
  if (f.purpose !== 'shop') return 'not_shop_session';
  if (f.orderId) return 'order_placed';
  if (f.revoked || f.expired) return 'session_closed';
  if (f.cartLines === 0) return 'cart_empty';
  if (f.delayMinutes === null) return 'disabled';
  if (!f.checkoutEnabled) return 'store_closed';
  return null;
}

/**
 * Queue the one reminder for a session that has just gone from an empty cart to
 * a non-empty one, when the store has a delay set at this moment. Same
 * transaction as the cart write; a repeat is a no-op (dedupe abandon:<id>).
 */
export async function queueAbandonedCartTx(tx: TenantTransaction, accountId: string, sessionId: string, now = new Date()): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ delay: number | null }[]>`
    SELECT abandoned_cart_delay_minutes AS delay FROM commerce_settings WHERE account_id=${accountId}::uuid`;
  if (!row?.delay) return false;
  const runAt = new Date(now.getTime() + row.delay * 60_000);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${ABANDONED_CART_JOB},${accountId}::uuid,${JSON.stringify({ sessionId })}::jsonb,${`abandon:${sessionId}`},${runAt})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}

/** Mark a freshly placed COD order pending and queue its confirmation message (same transaction as the order). */
export async function startCodConfirmationTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  await tx.$executeRaw`UPDATE orders SET cod_confirmation='pending' WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid
    AND payment_method='cod' AND cod_confirmation IS NULL`;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES(${COD_CONFIRM_JOB},${accountId}::uuid,${JSON.stringify({ orderId })}::jsonb,${`cod_confirm:${orderId}`})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}
