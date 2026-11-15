/**
 * The payment-link references of an order edit's balance link (Store Phase 5).
 * One per edit and attempt, so a replay finds the link it already made; a new
 * attempt is used only after Razorpay definitely refused the previous one.
 * Prefix co_ (the checkout family the payment webhook already recognises).
 */
import { createHash } from 'node:crypto';

export const BALANCE_LINK_ATTEMPTS = 5;

export function editBalanceReference(editId: string, attempt: number): string {
  return `co_${createHash('sha256').update(`order-edit-balance:${editId}:${attempt}`).digest('base64url').slice(0, 32)}`;
}

/** Every reference a balance link of this edit can carry. */
export function editBalanceReferences(editId: string): string[] {
  return Array.from({ length: BALANCE_LINK_ATTEMPTS }, (_, i) => editBalanceReference(editId, i + 1));
}
