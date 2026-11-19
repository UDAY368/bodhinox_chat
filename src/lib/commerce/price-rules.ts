/**
 * Price rules (store plan Phase 8). Pure arithmetic that priceCart calls: the
 * caller loads the buyer's price tiers, the discount rules that reach the
 * buyer, the gift rules and the balances inside its tenant transaction. Every
 * amount is an integer count of minor units; points are whole numbers.
 *
 * The one stacking order (priceCart applies it for the shop quote, the WhatsApp
 * cart, manual orders and the stored order):
 *  1. Unit price. The catalogue price, or the buyer's wholesale price: the
 *     lowest price-list tier whose minimum quantity the line reaches. A list
 *     never raises a price above the catalogue.
 *  2. Discount rules on the line (product, category or customer group). A
 *     percent is taken from the line amount (unit × quantity, half up); a fixed
 *     amount is taken from each unit. Combinable rules each read that same line
 *     amount and add up, never past it.
 *  3. Order-level automatic discounts (auto-discounts.ts), then the coupon, on
 *     what is left.
 *  4. Shipping, the cash-on-delivery fee and tax, as before. A free gift line
 *     is added at 0 when its rule holds on the merchandise after discounts.
 *  5. Loyalty points, then store credit, pay part of the total. They are
 *     payments, not discounts: tax and the order total do not change.
 *
 * A rule that does not combine never shares a line: the line takes that rule
 * alone and no automatic discount or coupon (the line does not count toward
 * their minimums either). priceCart prices the cart both ways, without those
 * rules and with the best one on each line that has one, and keeps the lower
 * total, so the buyer always gets the better result. A tie keeps the
 * combinable way.
 */
import { mulDivHalfUp } from './money';

export const PRICE_RULE_LIMITS = { maxGroups: 20, maxGroupMembers: 5000, maxLists: 20, maxPrices: 500, maxRules: 50, maxGiftRules: 10, maxName: 80, maxGiftsPerOrder: 5 } as const;

/** One price-list entry that applies to the buyer. */
export interface PricingPriceTier {
  variantId: string;
  minQty: number;
  priceMinor: number;
}

export interface PricingLineRule {
  id: string;
  name: string;
  /** One product, or null. */
  productId: string | null;
  /** The category with its sub-categories, or null. Both null: every product. */
  categoryIds: readonly string[] | null;
  kind: 'percent' | 'fixed';
  /** percent: basis points 1..10000. fixed: minor units off each unit. */
  value: number;
  combinable: boolean;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface PricingGiftRule {
  id: string;
  name: string;
  /** Spend at least this (merchandise after discounts), or null. */
  minSubtotalMinor: number | null;
  /** Have this product in the cart, or null. Exactly one condition is set. */
  triggerProductId: string | null;
  giftVariantId: string;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** What the buyer chose to pay with, already limited to their balances. Absent parts are not used. */
export interface PricingTender {
  /** Store credit balance to spend (0 = none). */
  storeCreditMinor: number;
  /** Points to spend: the balance, what one point pays, and the cap as a share of the order total. */
  points: { balance: number; valueMinor: number; maxBps: number } | null;
}

export interface RuleLine {
  productId: string;
  categoryId: string | null;
  unitMinor: number;
  qty: number;
  grossMinor: number;
}

export interface RuleSaving { id: string; name: string; savingMinor: number }

const BPS = 10_000;
const live = (rule: { active: boolean; startsAt: Date | null; endsAt: Date | null }, now: Date) =>
  rule.active && !(rule.startsAt && now < rule.startsAt) && !(rule.endsAt && now >= rule.endsAt);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const whole = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;

/** The unit price for a line: the lowest tier the quantity reaches, never above the catalogue price. */
export function tierUnitPrice(tiers: readonly PricingPriceTier[], variantId: string, qty: number, catalogueMinor: number): number {
  let unit = catalogueMinor;
  for (const tier of tiers)
    if (tier.variantId === variantId && whole(tier.minQty, 1, 99) && qty >= tier.minQty && whole(tier.priceMinor, 0, catalogueMinor))
      unit = Math.min(unit, tier.priceMinor);
  return unit;
}

function matches(rule: PricingLineRule, line: RuleLine): boolean {
  if (rule.productId !== null) return rule.productId === line.productId;
  if (rule.categoryIds !== null) return line.categoryId !== null && rule.categoryIds.includes(line.categoryId);
  return true;
}

/** What one rule alone takes off a line, never more than the line. */
export function ruleSaving(rule: PricingLineRule, line: RuleLine): number {
  if (rule.kind === 'percent') return whole(rule.value, 1, BPS) ? Math.min(mulDivHalfUp(line.grossMinor, rule.value, BPS), line.grossMinor) : 0;
  return whole(rule.value, 1, Number.MAX_SAFE_INTEGER) ? Math.min(Math.min(rule.value, line.unitMinor) * line.qty, line.grossMinor) : 0;
}

export interface LineRuleOutcome {
  /** The combinable rules that apply, in id order; their savings add up to at most the line amount. */
  combinable: RuleSaving[];
  combinableMinor: number;
  /** The best rule that does not combine (ties to the lowest id), or null. */
  exclusive: RuleSaving | null;
}

/** The discount rules for one line (step 2). */
export function lineRuleOutcome(rules: readonly PricingLineRule[], line: RuleLine, now: Date): LineRuleOutcome {
  const combinable: RuleSaving[] = [];
  let total = 0;
  let exclusive: RuleSaving | null = null;
  for (const rule of rules.filter((r) => live(r, now) && matches(r, line)).sort(byId)) {
    const saving = ruleSaving(rule, line);
    if (saving <= 0) continue;
    if (rule.combinable) {
      const part = Math.min(saving, line.grossMinor - total);
      if (part > 0) combinable.push({ id: rule.id, name: rule.name, savingMinor: part });
      total += part;
    } else if (!exclusive || saving > exclusive.savingMinor) exclusive = { id: rule.id, name: rule.name, savingMinor: saving };
  }
  return { combinable, combinableMinor: total, exclusive };
}

/** The gift rules whose condition holds, in id order, one per gift variant, at most five. */
export function giftsFor(rules: readonly PricingGiftRule[], merchandiseMinor: number, productIds: ReadonlySet<string>, now: Date): PricingGiftRule[] {
  const seen = new Set<string>();
  const out: PricingGiftRule[] = [];
  for (const rule of rules.filter((r) => live(r, now)).sort(byId)) {
    const holds = rule.minSubtotalMinor !== null ? merchandiseMinor >= rule.minSubtotalMinor
      : rule.triggerProductId !== null && productIds.has(rule.triggerProductId);
    if (!holds || seen.has(rule.giftVariantId) || out.length >= PRICE_RULE_LIMITS.maxGiftsPerOrder) continue;
    seen.add(rule.giftVariantId);
    out.push(rule);
  }
  return out;
}

export interface TenderOutcome {
  pointsRedeemed: number;
  pointsValueMinor: number;
  storeCreditMinor: number;
  /** What is left to pay with money. */
  payableMinor: number;
}

/**
 * Step 5: points first (whole points, at most the cap share of the total), then
 * store credit on the rest. Neither ever pays more than the total.
 */
export function tenderFor(totalMinor: number, tender: PricingTender | null | undefined): TenderOutcome {
  let points = 0, pointsValue = 0;
  const p = tender?.points;
  if (p && whole(p.balance, 1, Number.MAX_SAFE_INTEGER) && whole(p.valueMinor, 1, Number.MAX_SAFE_INTEGER) && whole(p.maxBps, 1, BPS)) {
    const cap = Number(BigInt(totalMinor) * BigInt(p.maxBps) / BigInt(BPS));
    points = Math.min(p.balance, Math.floor(cap / p.valueMinor));
    pointsValue = points * p.valueMinor;
  }
  const balance = tender && whole(tender.storeCreditMinor, 0, Number.MAX_SAFE_INTEGER) ? tender.storeCreditMinor : 0;
  const credit = Math.min(balance, totalMinor - pointsValue);
  return { pointsRedeemed: points, pointsValueMinor: pointsValue, storeCreditMinor: credit, payableMinor: totalMinor - pointsValue - credit };
}

// ---------------------------------------------------------------------------
// Loyalty ledger arithmetic

export const MAX_POINTS = 100_000_000;

/** Points for a paid amount: earnPoints for every earnSpendMinor, rounded down. */
export function pointsEarned(baseMinor: number, rule: { earnPoints: number; earnSpendMinor: number }): number {
  if (!whole(baseMinor, 1, Number.MAX_SAFE_INTEGER) || !whole(rule.earnPoints, 1, 1000) || !whole(rule.earnSpendMinor, 1, Number.MAX_SAFE_INTEGER)) return 0;
  const points = BigInt(baseMinor) * BigInt(rule.earnPoints) / BigInt(rule.earnSpendMinor);
  return points > BigInt(MAX_POINTS) ? MAX_POINTS : Number(points);
}

/**
 * Points to take back after a refund. The share of the earned points equal to
 * the share of the earning amount refunded so far (rounded down, so the buyer
 * keeps a fraction), all of them once it is refunded in full, minus what was
 * already taken back. Never negative.
 */
export function earnReversal(earned: number, alreadyReversed: number, refundedMinor: number, baseMinor: number): number {
  if (earned <= 0 || refundedMinor <= 0) return 0;
  const target = baseMinor <= 0 || refundedMinor >= baseMinor ? earned : Number(BigInt(earned) * BigInt(refundedMinor) / BigInt(baseMinor));
  return Math.max(0, Math.min(target, earned) - alreadyReversed);
}
