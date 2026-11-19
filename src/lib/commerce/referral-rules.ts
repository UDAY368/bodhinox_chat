/**
 * Store plan Phase 8, batch 6: the pure rules of the referral program. Codes, who may be rewarded, how much, and when.
 *
 * Decisions (also in the docs):
 *  - A code is attributed when an order is placed from a cart made through a shop link carrying it. Only a buyer's first
 *    referred order counts (one row per buyer), and a buyer is never their own referrer.
 *  - The reward is store credit (a fixed amount the shop sets) for the referrer, or a commission figure (a share of the
 *    order's net amount) in the affiliate report. It is settled once the order is paid and the hold has passed, which is never
 *    shorter than the shop's own return window. The net amount is the total minus what was refunded by then; an order that was
 *    cancelled or refunded in full earns nothing. A refund after settling does not take the credit back.
 */
import { randomInt } from 'node:crypto';

export const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
export const AFFILIATE_LIMIT = 200;
export const MAX_COMMISSION_BPS = 5000;

export function newReferralCode(): string {
  return Array.from({ length: 8 }, () => REFERRAL_ALPHABET[randomInt(0, REFERRAL_ALPHABET.length)]).join('');
}

/** What a visitor's link may carry; anything else is ignored (never an error: a bad link still shows the shop). */
export function parseReferralParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return REFERRAL_CODE.test(code) ? code : null;
}

export interface AttributionFacts {
  code: { active: boolean; kind: 'contact' | 'affiliate'; contactId: string | null; email?: string | null };
  buyer: { contactId: string; email: string | null };
}

/** Why an order is not attributed to a code (null: it is). A buyer is never their own referrer, by contact or by email. */
export function attributionRefusal(facts: AttributionFacts): string | null {
  if (!facts.code.active) return 'code_inactive';
  if (facts.code.kind === 'contact' && facts.code.contactId === facts.buyer.contactId) return 'self_referral';
  const a = facts.code.email?.trim().toLowerCase(), b = facts.buyer.email?.trim().toLowerCase();
  if (a && b && a === b) return 'self_referral';
  return null;
}

/** Days to wait after payment: the shop's hold, and never less than the buyer return window when buyers can return. */
export function holdDays(holdSetting: number, returnWindowDays: number | null): number {
  return Math.max(holdSetting, returnWindowDays ?? 0);
}

export function rewardDueAt(paidAt: Date, days: number): Date {
  return new Date(paidAt.getTime() + days * 86_400_000);
}

export type Settlement =
  | { status: 'skipped'; reason: string }
  | { status: 'rewarded'; netMinor: number; rewardMinor: number; commissionMinor: number };

export interface SettleFacts {
  kind: 'contact' | 'affiliate';
  orderStatus: string;
  paid: boolean;
  totalMinor: number;
  refundedMinor: number;
  rewardMinor: number;
  commissionBps: number | null;
  hasReferrer: boolean;
}

/** Decide one referral at its due time. Integer arithmetic only (basis points of the net amount, rounded down). */
export function settleReferral(f: SettleFacts): Settlement {
  if (!f.paid) return { status: 'skipped', reason: 'not_paid' };
  if (f.orderStatus === 'cancelled' || f.orderStatus === 'expired') return { status: 'skipped', reason: 'order_cancelled' };
  const net = Math.max(0, f.totalMinor - f.refundedMinor);
  if (net <= 0) return { status: 'skipped', reason: 'refunded' };
  if (f.kind === 'contact') {
    if (!f.hasReferrer) return { status: 'skipped', reason: 'referrer_gone' };
    if (f.rewardMinor <= 0) return { status: 'skipped', reason: 'no_reward' };
    return { status: 'rewarded', netMinor: net, rewardMinor: f.rewardMinor, commissionMinor: 0 };
  }
  return { status: 'rewarded', netMinor: net, rewardMinor: 0, commissionMinor: Math.floor((net * (f.commissionBps ?? 0)) / 10_000) };
}

/** Ledger key of the credit: one per order, ever. */
export const referralCreditKey = (orderId: string) => `referral:${orderId}`;
