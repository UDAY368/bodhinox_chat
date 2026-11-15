/**
 * Automatic discounts (store plan Phase 3). Pure: the caller loads the
 * workspace's rules and priceCart calls this before the coupon. Every amount
 * is an integer count of minor units.
 *
 * Rules:
 *  - Only active rules inside their dates count.
 *  - Of the order-level money rules (amount_off_over, percent_off_over,
 *    buy_x_get_y) only the one that saves the most applies; ties go to the
 *    lowest id. Their minimum is read against the cart subtotal.
 *  - `prepaid` (money off for paying online) stacks on top of it, only when
 *    the customer pays online. Its minimum and its percent read the subtotal
 *    left after the order-level rule. With several, the best one applies.
 *  - `free_shipping_over` makes shipping free when the subtotal after the
 *    order-level rule reaches its minimum. The prepaid discount is not taken
 *    off first, so paying online never loses free shipping that cash on
 *    delivery would get. priceCart sets the fee to 0.
 *  - buy_x_get_y: among the eligible units (the rule's products, or all), for
 *    every buy+get units the cheapest `get` units are free; the saving sits on
 *    the lines those units belong to.
 *  - No line ever goes below zero: each line's share is at most what is left
 *    of its gross amount.
 */
import { allocateLargestRemainder, mulDivHalfUp } from './money';

export type AutoDiscountKind = 'amount_off_over' | 'percent_off_over' | 'free_shipping_over' | 'buy_x_get_y' | 'prepaid';
export const AUTO_DISCOUNT_KINDS: readonly AutoDiscountKind[] = ['amount_off_over', 'percent_off_over', 'free_shipping_over', 'buy_x_get_y', 'prepaid'];
export const AUTO_DISCOUNT_LIMITS = { maxRules: 20, maxName: 80, maxQty: 20, maxProducts: 50 } as const;

export interface PricingAutoDiscount {
  id: string;
  name: string;
  kind: AutoDiscountKind;
  minSubtotalMinor: number;
  /** amount_off_over, or prepaid as a fixed amount. */
  amountMinor: number | null;
  /** percent_off_over, or prepaid as a percent. Basis points, 1..10000. */
  percentBps: number | null;
  buyQty: number | null;
  getQty: number | null;
  /** buy_x_get_y: the products that count; empty means every product. */
  productIds: string[];
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

export interface AutoDiscountLine {
  productId: string;
  unitMinor: number;
  qty: number;
  grossMinor: number;
}

export interface AppliedAutoDiscount {
  id: string;
  name: string;
  kind: AutoDiscountKind;
  /** What the customer saves. For free shipping: the delivery fee waived. */
  savingMinor: number;
}

/** One entry of orders.discount_details: what the customer was shown. */
export interface StoredDiscountDetail {
  name: string;
  kind: AutoDiscountKind;
  saving_minor: number;
}

/** Read orders.discount_details back to its fixed shape; anything malformed is dropped. */
export function parseDiscountDetails(value: unknown): StoredDiscountDetail[] {
  if (!Array.isArray(value)) return [];
  const out: StoredDiscountDetail[] = [];
  for (const entry of value.slice(0, 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const kind = AUTO_DISCOUNT_KINDS.find((k) => k === e.kind);
    if (typeof e.name === 'string' && kind && typeof e.saving_minor === 'number' && Number.isSafeInteger(e.saving_minor) && e.saving_minor >= 0)
      out.push({ name: e.name.slice(0, AUTO_DISCOUNT_LIMITS.maxName), kind, saving_minor: e.saving_minor });
  }
  return out;
}

export interface AutoDiscountOutcome {
  /** The money rules applied (the best order-level rule, then prepaid), in that order. */
  applied: AppliedAutoDiscount[];
  /** Per line, in the order given; each is at most the line's gross. Sums to discountMinor. */
  lineDiscounts: number[];
  discountMinor: number;
  /** The free-shipping rule that applies, if any. */
  freeShipping: { id: string; name: string } | null;
  /** When paying by COD: what the best prepaid rule would save if the customer paid online. */
  prepaidOffer: AppliedAutoDiscount | null;
}

const BPS = 10_000;
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Active and inside its dates now (starts_at inclusive, ends_at exclusive, like coupons). */
export function autoDiscountLive(rule: PricingAutoDiscount, now: Date): boolean {
  return rule.active && !(rule.startsAt && now < rule.startsAt) && !(rule.endsAt && now >= rule.endsAt);
}

const valid = (n: number | null, min: number, max: number): n is number => n !== null && Number.isSafeInteger(n) && n >= min && n <= max;

/** Percent or amount off `base`, never more than `base`. A rule with neither saves nothing. */
function moneyOff(rule: PricingAutoDiscount, base: number): number {
  if (valid(rule.percentBps, 1, BPS)) return Math.min(mulDivHalfUp(base, rule.percentBps, BPS), base);
  if (valid(rule.amountMinor, 1, Number.MAX_SAFE_INTEGER)) return Math.min(rule.amountMinor, base);
  return 0;
}

/** Buy X get Y: per line, the value of its free units (the cheapest eligible units, ties to the earlier line). */
export function buyXGetYShares(rule: PricingAutoDiscount, lines: readonly AutoDiscountLine[]): number[] {
  const shares = lines.map(() => 0);
  if (!valid(rule.buyQty, 1, AUTO_DISCOUNT_LIMITS.maxQty) || !valid(rule.getQty, 1, AUTO_DISCOUNT_LIMITS.maxQty)) return shares;
  const only = rule.productIds.length ? new Set(rule.productIds) : null;
  const eligible = lines.map((line, index) => ({ line, index })).filter(({ line }) => !only || only.has(line.productId));
  const units = sum(eligible.map(({ line }) => line.qty));
  let free = Math.floor(units / (rule.buyQty + rule.getQty)) * rule.getQty;
  eligible.sort((a, b) => a.line.unitMinor - b.line.unitMinor || a.index - b.index);
  for (const { line, index } of eligible) {
    if (free <= 0) break;
    const take = Math.min(free, line.qty);
    shares[index] = Math.min(take * line.unitMinor, line.grossMinor);
    free -= take;
  }
  return shares;
}

/** Work out the automatic discounts for a cart. Never throws for business input. */
export function applyAutoDiscounts(
  rules: readonly PricingAutoDiscount[], lines: readonly AutoDiscountLine[], paymentMethod: 'online' | 'cod', now: Date,
): AutoDiscountOutcome {
  const live = rules.filter((r) => autoDiscountLive(r, now)).sort(byId);
  const gross = lines.map((l) => l.grossMinor);
  const subtotal = sum(gross);
  let lineDiscounts = lines.map(() => 0);
  const applied: AppliedAutoDiscount[] = [];

  // 1. The single best order-level rule (sorted by id, so a tie keeps the lowest id).
  let best: { rule: PricingAutoDiscount; saving: number; shares: number[] | null } | null = null;
  for (const rule of live) {
    if (rule.kind !== 'amount_off_over' && rule.kind !== 'percent_off_over' && rule.kind !== 'buy_x_get_y') continue;
    if (subtotal < rule.minSubtotalMinor) continue;
    const shares = rule.kind === 'buy_x_get_y' ? buyXGetYShares(rule, lines) : null;
    const saving = shares ? sum(shares) : moneyOff(rule, subtotal);
    if (saving > 0 && (!best || saving > best.saving)) best = { rule, saving, shares };
  }
  if (best) {
    lineDiscounts = best.shares ?? allocateLargestRemainder(best.saving, gross);
    applied.push({ id: best.rule.id, name: best.rule.name, kind: best.rule.kind, savingMinor: best.saving });
  }

  // 2. Prepaid on what is left: applied when paying online, offered when paying by COD.
  const remaining = gross.map((g, i) => g - lineDiscounts[i]);
  const reduced = sum(remaining);
  let prepaid: AppliedAutoDiscount | null = null;
  for (const rule of live) {
    if (rule.kind !== 'prepaid' || reduced < rule.minSubtotalMinor) continue;
    const saving = moneyOff(rule, reduced);
    if (saving > 0 && (!prepaid || saving > prepaid.savingMinor)) prepaid = { id: rule.id, name: rule.name, kind: 'prepaid', savingMinor: saving };
  }
  if (prepaid && paymentMethod === 'online') {
    const shares = allocateLargestRemainder(prepaid.savingMinor, remaining);
    lineDiscounts = lineDiscounts.map((d, i) => d + shares[i]);
    applied.push(prepaid);
  }

  // 3. Free shipping reads the subtotal after the order-level rule and before prepaid (`reduced`),
  // so the answer is the same for both payment methods.
  const discountMinor = sum(lineDiscounts);
  const free = live.find((r) => r.kind === 'free_shipping_over' && reduced >= r.minSubtotalMinor);
  return {
    applied, lineDiscounts, discountMinor,
    freeShipping: free ? { id: free.id, name: free.name } : null,
    prepaidOffer: prepaid && paymentMethod === 'cod' ? prepaid : null,
  };
}
