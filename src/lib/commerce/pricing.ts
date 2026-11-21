/**
 * Server pricing (design E2, E3, E4). Pure: the caller loads the variants,
 * settings, shipping rates and coupon inside its tenant transaction and this
 * module does the arithmetic. Every amount is an integer count of minor units
 * of the store currency; nothing here ever touches a float.
 *
 * Order of operations (E4):
 *  1. unit = the catalogue price, or the buyer's wholesale price-list price (price-rules.ts);
 *     line_gross = unit × qty, subtotal = Σ line_gross
 *  1b. discount rules on the line (product, category or customer group; price-rules.ts). A rule that does not
 *     combine is used only when the whole cart is cheaper that way; its line then takes nothing from steps 2-3
 *  2. automatic discounts (auto-discounts.ts): the best order-level rule, then
 *     the prepaid rule when paying online; each sits on its lines
 *  2b. coupon discount on the merchandise left after them (percent:
 *     min(round(reduced × bps), max_discount, reduced); fixed: min(value,
 *     reduced)); its minimum reads the reduced subtotal too
 *  3. the coupon is split across lines by largest remainder on what is left of
 *     each line; discount = automatic + coupon, and the line discounts sum to it
 *  4. taxable = line_gross − line_discount; exclusive tax = round(taxable × bps);
 *     inclusive tax = taxable − round(taxable × 10000 / (10000 + bps))
 *  5. shipping is taxed the same way at its own rate (a free-shipping rule sets
 *     the fee to 0; its minimum reads the subtotal after the order-level
 *     automatic rule, before the prepaid discount and the coupon); a cash-on-delivery (COD)
 *     fee is taxed like shipping at the store's default rate
 *  5b. store pickup and local delivery (Phase 8) take the place of the shipping
 *     rate: pickup is free, local delivery charges the store's own fee (taxed
 *     at the store's default rate, waived by a free-shipping rule) and only
 *     reaches the postal prefixes the store listed
 *  5c. a cart of only digital products (Phase 8) needs no address and no shipping: shipping is 0, whatever
 *     delivery method was chosen, and the order records 'ship'; cash on delivery is refused for it (the product
 *     is not collectable). A bundle is an ordinary line at the bundle's own price (its parts only matter to stock);
 *     a pre-order line carries its ship date through to the order.
 *  5d. a free gift (Phase 8): a gift rule that holds on the merchandise after discounts adds its variant as a
 *     line at 0, when one unit is available. It is an ordinary line for stock, shipping and cash on delivery.
 *  6. total = subtotal − discount + shipping + cod_fee + (inclusive ? 0 : tax_total)
 *  7. loyalty points, then store credit, pay part of the total (Phase 8). They are payments, not discounts:
 *     the total and the tax do not change; payable = total − points value − store credit.
 *
 * The COD fee is never discounted and never counts toward a coupon minimum or
 * a shipping band: those read the merchandise amount only.
 *
 * Refusals are codes, never guesses: an unpriced line, a needed tax rate that
 * is not configured, or no matching shipping rate refuses instead of
 * assuming zero (PRD :121).
 */
import { applyAutoDiscounts, type AppliedAutoDiscount, type PricingAutoDiscount } from './auto-discounts';
import { allocateLargestRemainder, MAX_MINOR, mulDivHalfUp, roundHalfUp } from './money';
import {
  giftsFor, lineRuleOutcome, tenderFor, tierUnitPrice, type PricingGiftRule, type PricingLineRule, type PricingPriceTier, type PricingTender,
  type RuleSaving,
} from './price-rules';

export const CART_LIMITS = { maxLines: 50, maxQty: 99 } as const;

export type PricingRefusal =
  | 'cart_empty'
  | 'invalid_cart'
  | 'variant_unavailable'
  | 'price_not_configured'
  | 'tax_not_configured'
  | 'shipping_unavailable'
  | 'coupon_not_found'
  | 'coupon_inactive'
  | 'coupon_not_started'
  | 'coupon_expired'
  | 'coupon_min_subtotal'
  | 'amount_out_of_range'
  | 'cod_unavailable'
  | 'delivery_unavailable';

export type PaymentMethod = 'online' | 'cod';
export const isPaymentMethod = (value: unknown): value is PaymentMethod => value === 'online' || value === 'cod';

/** How the order reaches the customer: a shipping rate, collection at the store, or the store's own local delivery. */
export type DeliveryMethod = 'ship' | 'pickup' | 'local';
export const isDeliveryMethod = (value: unknown): value is DeliveryMethod => value === 'ship' || value === 'pickup' || value === 'local';

/** The store's pickup and local delivery settings as pricing reads them. */
export interface PricingDeliveryOptions {
  pickupEnabled: boolean;
  localEnabled: boolean;
  localFeeMinor: number;
  /** Postal code prefixes local delivery reaches (upper case, no spaces). None listed = nowhere. */
  localPostalPrefixes: readonly string[];
}

export interface PricingVariant {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  optionValues: Record<string, string>;
  priceMinor: number | null;
  taxRateBps: number | null;
  hsnCode: string | null;
  trackInventory: boolean;
  /** Published product and not archived. */
  sellable: boolean;
  /** The product allows cash on delivery (absent = allowed). */
  codAvailable?: boolean;
  /** Shipping weight of one unit in grams (absent or null counts as 0). */
  weightGrams?: number | null;
  /** A digital product: no shipping (absent = physical). */
  digital?: boolean;
  /** The variant is on pre-order and ships by this date, YYYY-MM-DD (absent = in the usual stock). */
  preorderShipDate?: string | null;
  /** The product's category, for category discount rules (absent = none). */
  categoryId?: string | null;
  /** Units that can be bought now (null or absent = no limit). Read only to decide whether a free gift can be added. */
  available?: number | null;
}

export interface PricingSettings {
  currency: string;
  pricesIncludeTax: boolean;
  defaultTaxRateBps: number | null;
  /** The store offers cash on delivery (absent = off). */
  codEnabled?: boolean;
  /** The COD fee in minor units (absent = 0). */
  codFeeMinor?: number;
}

export interface PricingShippingRate {
  id: string;
  name: string;
  country: string;
  postalPrefixes: string[];
  minSubtotalMinor: number;
  maxSubtotalMinor: number | null;
  feeMinor: number;
  taxRateBps: number | null;
  position: number;
  /** Zone: state names or codes. A rate with no prefixes and no states covers the whole country. */
  states?: string[];
  /** Weight slab: feeMinor covers up to baseWeightGrams, then extraPerStepMinor for every started stepGrams. Both step fields set, or neither. */
  baseWeightGrams?: number | null;
  stepGrams?: number | null;
  extraPerStepMinor?: number | null;
  /** A cart heavier than this is not shipped by this rate. */
  maxWeightGrams?: number | null;
  /** The fee is 0 once the merchandise (after discounts) reaches this. */
  freeOverMinor?: number | null;
  /** Cash on delivery is allowed for this zone (absent = allowed). */
  codAllowed?: boolean;
}

export interface PricingCoupon {
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  minSubtotalMinor: number;
  maxDiscountMinor: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

export interface PricingAddress {
  country: string;
  postalCode: string;
  /** State name and/or code, matched against a rate's states without regard to case. */
  state?: string | null;
  stateCode?: string | null;
}

export interface CartLine {
  variantId: string;
  qty: number;
}

export interface QuoteLine {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  optionValues: Record<string, string>;
  hsnCode: string | null;
  trackInventory: boolean;
  /** This line's product allows cash on delivery. */
  codAvailable: boolean;
  /** A digital product. */
  digital: boolean;
  /** Pre-order: the date this line ships by (YYYY-MM-DD), else null. */
  preorderShipDate: string | null;
  qty: number;
  /** The unit price charged: the catalogue price, or the buyer's price-list price. */
  unitPriceMinor: number;
  /** The catalogue unit price (above unitPriceMinor when a price list applied). */
  catalogPriceMinor: number;
  grossMinor: number;
  discountMinor: number;
  taxRateBps: number;
  taxMinor: number;
  /** What the line costs the customer: taxable, plus tax when prices exclude it. */
  lineTotalMinor: number;
  /** A free gift added by a gift rule (unit price 0). */
  gift: boolean;
  /** The gift rule's name, for a gift line. */
  giftName: string | null;
}

export interface Quote {
  currency: string;
  taxInclusive: boolean;
  lines: QuoteLine[];
  subtotalMinor: number;
  /** Every discount on the merchandise: automatic discounts plus the coupon. The line discounts sum to it. */
  discountMinor: number;
  /** The automatic part of discountMinor (the coupon's part is the rest): discount rules plus automatic discounts. */
  autoDiscountMinor: number;
  /** The part of autoDiscountMinor that came from discount rules on lines. */
  ruleDiscountMinor: number;
  /** The discount rules (kind 'price_rule'), then the automatic discounts applied, in order. A free-shipping entry carries the fee waived and is not part of autoDiscountMinor. */
  autoDiscounts: AppliedAutoDiscount[];
  /** Paying by COD: what paying online would save through the prepaid rule (0 when there is none). */
  prepaidSavingMinor: number;
  couponCode: string | null;
  /** How the order reaches the customer. */
  deliveryMethod: DeliveryMethod;
  /** Every line is a digital product: no address or shipping is needed. */
  digitalOnly: boolean;
  /** The latest ship date among the pre-order lines (the date the whole order is promised by), else null. */
  preorderShipDate: string | null;
  /**
   * null until an address is known (a quote without shipping cannot be placed). For pickup and local
   * delivery rateId is the method name and name is empty: the page words them itself.
   */
  shipping: { rateId: string; name: string; feeMinor: number; taxRateBps: number; taxMinor: number } | null;
  shippingMinor: number;
  /** How the customer pays: online (payment link) or cash on delivery. */
  paymentMethod: PaymentMethod;
  /** The store offers COD and every line's product allows it. */
  codAvailable: boolean;
  /** The COD fee line, only when paying by COD. */
  codFee: { feeMinor: number; taxRateBps: number; taxMinor: number } | null;
  codFeeMinor: number;
  /** Line tax plus shipping tax plus COD fee tax. */
  taxMinor: number;
  totalMinor: number;
  /** Loyalty points spent on this order and what they pay. */
  pointsRedeemed: number;
  pointsValueMinor: number;
  /** Store credit spent on this order. */
  storeCreditMinor: number;
  /** What is left to pay with money: totalMinor − pointsValueMinor − storeCreditMinor. */
  payableMinor: number;
}

export type PricingResult =
  | { ok: true; quote: Quote }
  | { ok: false; code: PricingRefusal; variantId?: string };

export interface PriceCartInput {
  lines: CartLine[];
  variants: ReadonlyMap<string, PricingVariant> | PricingVariant[];
  settings: PricingSettings;
  shippingRates: PricingShippingRate[];
  /** The coupon the session applied (looked up by code), null for none; `missing` when the code matched nothing. */
  coupon: PricingCoupon | null | 'missing';
  address: PricingAddress | null;
  /** The customer's choice (absent = online). COD is refused unless the store and every product allow it. */
  paymentMethod?: PaymentMethod;
  /** The customer's delivery choice (absent = a shipping rate). Pickup and local delivery are refused unless the store offers them. */
  deliveryMethod?: DeliveryMethod;
  /** The store's pickup and local delivery settings (absent = neither is offered). */
  deliveryOptions?: PricingDeliveryOptions | null;
  /** The workspace's automatic discount rules (absent = none). Applied before the coupon. */
  autoDiscounts?: readonly PricingAutoDiscount[];
  /** The buyer's wholesale price-list entries (absent = catalogue prices). */
  priceTiers?: readonly PricingPriceTier[];
  /** The discount rules that reach this buyer (absent = none). */
  lineRules?: readonly PricingLineRule[];
  /** The workspace's gift rules (absent = none). A gift's variant must be in `variants`. */
  giftRules?: readonly PricingGiftRule[];
  /** Points and store credit the buyer chose to pay with (absent = none). */
  tender?: PricingTender | null;
  now?: Date;
}

const BPS = 10_000;

/** Same lines merged by variant (first-seen order kept); null for a malformed cart. */
export function normaliseCart(lines: readonly CartLine[]): CartLine[] | null {
  const merged = new Map<string, number>();
  for (const line of lines) {
    if (!line || typeof line.variantId !== 'string' || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > CART_LIMITS.maxQty) return null;
    merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.qty);
  }
  if (merged.size > CART_LIMITS.maxLines) return null;
  const out = [...merged].map(([variantId, qty]) => ({ variantId, qty }));
  return out.some((l) => l.qty > CART_LIMITS.maxQty) ? null : out;
}

/** Tax on a taxable amount at `bps`, inclusive or exclusive (E4 step 4). */
export function taxOn(taxable: number, bps: number, inclusive: boolean): number {
  if (bps === 0 || taxable === 0) return 0;
  return inclusive ? taxable - roundHalfUp(BigInt(taxable) * BigInt(BPS), BPS + bps) : mulDivHalfUp(taxable, bps, BPS);
}

/** The coupon's discount on `subtotal`, or a refusal. */
export function couponDiscount(coupon: PricingCoupon, subtotal: number, now: Date): { ok: true; discount: number } | { ok: false; code: PricingRefusal } {
  if (!coupon.active) return { ok: false, code: 'coupon_inactive' };
  if (coupon.startsAt && now < coupon.startsAt) return { ok: false, code: 'coupon_not_started' };
  if (coupon.endsAt && now >= coupon.endsAt) return { ok: false, code: 'coupon_expired' };
  if (subtotal < coupon.minSubtotalMinor) return { ok: false, code: 'coupon_min_subtotal' };
  let discount = coupon.kind === 'percent' ? mulDivHalfUp(subtotal, coupon.value, BPS) : coupon.value;
  if (coupon.maxDiscountMinor !== null) discount = Math.min(discount, coupon.maxDiscountMinor);
  return { ok: true, discount: Math.min(discount, subtotal) };
}

const postal = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
const stateKey = (value: string) => value.toUpperCase().replace(/[^0-9A-Z]/g, '');

/** The fee of `rate` for a cart: the base fee plus the weight slab, or 0 past the free threshold. */
export function shippingFeeMinor(rate: PricingShippingRate, weightGrams: number, merchandiseMinor: number): number {
  if (rate.freeOverMinor != null && merchandiseMinor >= rate.freeOverMinor) return 0;
  if (rate.stepGrams == null || rate.extraPerStepMinor == null || rate.stepGrams < 1) return rate.feeMinor;
  const over = Math.max(0, weightGrams - (rate.baseWeightGrams ?? 0));
  const steps = Math.ceil(over / rate.stepGrams);
  const fee = BigInt(rate.feeMinor) + BigInt(steps) * BigInt(rate.extraPerStepMinor);
  return fee > BigInt(MAX_MINOR) ? MAX_MINOR : Number(fee);
}

/** Local delivery reaches this postal code: the store offers it and one of its prefixes matches. */
export function localDeliveryReaches(options: PricingDeliveryOptions | null | undefined, postalCode: string): boolean {
  if (!options?.localEnabled) return false;
  const code = postal(postalCode);
  return code.length > 0 && options.localPostalPrefixes.some((prefix) => prefix.length > 0 && code.startsWith(postal(prefix)));
}

/**
 * The delivery methods a buyer can pick. Without an address local delivery is listed when the store
 * offers it (the address decides later, and the quote refuses delivery_unavailable if it is out of reach).
 */
export function availableDeliveryMethods(options: PricingDeliveryOptions | null | undefined, address: PricingAddress | null): DeliveryMethod[] {
  const methods: DeliveryMethod[] = ['ship'];
  if (options?.pickupEnabled) methods.push('pickup');
  if (options?.localEnabled && (!address || localDeliveryReaches(options, address.postalCode))) methods.push('local');
  return methods;
}

/**
 * The shipping rate for an address, cart weight and merchandise amount (after
 * discount). A postal prefix match beats a state match, which beats a
 * whole-country rate (empty prefixes and states); among prefixes the longest
 * wins, then the lower position, then the lower fee. A rate whose weight limit
 * the cart exceeds is skipped.
 */
export function pickShippingRate(rates: readonly PricingShippingRate[], address: PricingAddress, merchandiseMinor: number,
  options: { weightGrams?: number } = {}): PricingShippingRate | null {
  const code = postal(address.postalCode);
  const weight = options.weightGrams ?? 0;
  const states = new Set([address.state, address.stateCode].flatMap((s) => (s ? [stateKey(s)] : [])));
  let best: { rate: PricingShippingRate; specificity: number; fee: number } | null = null;
  for (const rate of rates) {
    if (rate.country !== address.country.toUpperCase()) continue;
    if (merchandiseMinor < rate.minSubtotalMinor) continue;
    if (rate.maxSubtotalMinor !== null && merchandiseMinor > rate.maxSubtotalMinor) continue;
    if (rate.maxWeightGrams != null && weight > rate.maxWeightGrams) continue;
    const zoneStates = rate.states ?? [];
    let specificity = -1;
    if (!rate.postalPrefixes.length && !zoneStates.length) specificity = 0;
    for (const prefix of rate.postalPrefixes) if (code.startsWith(prefix)) specificity = Math.max(specificity, 10 + prefix.length);
    if (zoneStates.some((s) => states.has(stateKey(s)))) specificity = Math.max(specificity, 5);
    if (specificity < 0) continue;
    const fee = shippingFeeMinor(rate, weight, merchandiseMinor);
    if (!best || specificity > best.specificity
      || (specificity === best.specificity && (rate.position < best.rate.position
        || (rate.position === best.rate.position && fee < best.fee))))
      best = { rate, specificity, fee };
  }
  return best?.rate ?? null;
}

export interface ShippingQuoteForPincode {
  deliverable: boolean;
  /** The shipping fee in minor units (0 when not deliverable). */
  priceMinor: number;
  /** The zone allows cash on delivery. The store-wide COD switch and each product's flag are separate. */
  cod: boolean;
  rateName: string | null;
}

/**
 * Can the store ship to this pincode, at what price, and does that zone take
 * COD. Pass the workspace's active rates (`selectRates(...).map(pricingRate)`).
 * Pure: no database.
 */
export function quoteShippingForPincode(rates: readonly PricingShippingRate[], input: {
  pincode: string; country?: string; state?: string | null; stateCode?: string | null; weightGrams?: number; subtotalMinor?: number;
}): ShippingQuoteForPincode {
  const weight = Math.max(0, Math.floor(input.weightGrams ?? 0));
  const subtotal = input.subtotalMinor ?? 0;
  const rate = pickShippingRate(rates, { country: input.country ?? 'IN', postalCode: input.pincode, state: input.state, stateCode: input.stateCode },
    subtotal, { weightGrams: weight });
  if (!rate) return { deliverable: false, priceMinor: 0, cod: false, rateName: null };
  return { deliverable: true, priceMinor: shippingFeeMinor(rate, weight, subtotal), cod: rate.codAllowed !== false, rateName: rate.name };
}

function safeAdd(...values: number[]): number | null {
  let sum = BigInt(0);
  for (const v of values) sum += BigInt(v);
  return sum > BigInt(MAX_MINOR) || sum < BigInt(0) ? null : Number(sum);
}

/**
 * Price a cart (E2-E4). Never throws for bad business input: refusals come back as codes.
 * Priced without the rules that do not combine, and again with them when a line has one: the lower total wins
 * (a tie, or a refusal of the second pricing, keeps the first).
 */
export function priceCart(input: PriceCartInput): PricingResult {
  const base = priceWith(input, false);
  if (!base.result.ok || !base.exclusive) return base.result;
  const alt = priceWith(input, true).result;
  return alt.ok && alt.quote.totalMinor < base.result.quote.totalMinor ? alt : base.result;
}

type Priced = { variant: PricingVariant; qty: number; unit: number; gross: number; bps: number; ruleMinor: number; closed: boolean; parts: RuleSaving[] };

function priceWith(input: PriceCartInput, useExclusive: boolean): { result: PricingResult; exclusive: boolean } {
  let exclusive = false;
  const result = price(input, useExclusive, () => { exclusive = true; });
  return { result, exclusive };
}

function price(input: PriceCartInput, useExclusive: boolean, sawExclusive: () => void): PricingResult {
  const now = input.now ?? new Date();
  const lines = normaliseCart(input.lines);
  if (!lines) return { ok: false, code: 'invalid_cart' };
  if (!lines.length) return { ok: false, code: 'cart_empty' };
  const variants = input.variants instanceof Map ? input.variants : new Map((input.variants as PricingVariant[]).map((v) => [v.id, v]));
  const { settings } = input;
  const inclusive = settings.pricesIncludeTax;

  const priced: Priced[] = [];
  for (const line of lines) {
    const variant = variants.get(line.variantId);
    if (!variant || !variant.sellable) return { ok: false, code: 'variant_unavailable', variantId: line.variantId };
    if (variant.priceMinor === null) return { ok: false, code: 'price_not_configured', variantId: line.variantId };
    const bps = variant.taxRateBps ?? settings.defaultTaxRateBps;
    if (bps === null) return { ok: false, code: 'tax_not_configured', variantId: line.variantId };
    const unit = tierUnitPrice(input.priceTiers ?? [], variant.id, line.qty, variant.priceMinor);
    const big = BigInt(unit) * BigInt(line.qty);
    if (big > BigInt(MAX_MINOR)) return { ok: false, code: 'amount_out_of_range' };
    const gross = Number(big);
    const rules = lineRuleOutcome(input.lineRules ?? [],
      { productId: variant.productId, categoryId: variant.categoryId ?? null, unitMinor: unit, qty: line.qty, grossMinor: gross }, now);
    if (rules.exclusive) sawExclusive();
    // A rule that does not combine takes the line alone, and only when it beats the combinable rules on it.
    const closed = useExclusive && rules.exclusive !== null && rules.exclusive.savingMinor > rules.combinableMinor;
    const parts = closed ? [rules.exclusive!] : rules.combinable;
    priced.push({ variant, qty: line.qty, unit, gross, bps, ruleMinor: parts.reduce((n, r) => n + r.savingMinor, 0), closed, parts });
  }
  const subtotal = safeAdd(...priced.map((p) => p.gross));
  if (subtotal === null) return { ok: false, code: 'amount_out_of_range' };

  const paymentMethod: PaymentMethod = input.paymentMethod ?? 'online';
  // Automatic discounts and the coupon read the open lines only, at what the discount rules left of them.
  const open = priced.map((_, i) => i).filter((i) => !priced[i].closed);
  const auto = applyAutoDiscounts(input.autoDiscounts ?? [],
    open.map((i) => ({ productId: priced[i].variant.productId, unitMinor: priced[i].unit, qty: priced[i].qty, grossMinor: priced[i].gross - priced[i].ruleMinor })),
    paymentMethod, now);
  const autoLine = priced.map(() => 0);
  open.forEach((i, k) => { autoLine[i] = auto.lineDiscounts[k]; });
  const ruleDiscountMinor = priced.reduce((n, p) => n + p.ruleMinor, 0);
  // One entry per discount rule (its saving over every line), then the automatic discounts.
  const ruleEntries = new Map<string, AppliedAutoDiscount>();
  for (const p of priced) for (const part of p.parts) {
    const entry = ruleEntries.get(part.id);
    if (entry) entry.savingMinor += part.savingMinor;
    else ruleEntries.set(part.id, { id: part.id, name: part.name, kind: 'price_rule', savingMinor: part.savingMinor });
  }
  const autoDiscounts = [...ruleEntries.values(), ...auto.applied];
  // What is left of each line after the rules and the automatic discounts: the coupon works on the open ones.
  const remaining = priced.map((p, i) => p.gross - p.ruleMinor - autoLine[i]);
  const reduced = open.reduce((n, i) => n + remaining[i], 0);

  let couponMinor = 0;
  let couponCode: string | null = null;
  if (input.coupon === 'missing') return { ok: false, code: 'coupon_not_found' };
  if (input.coupon) {
    const applied = couponDiscount(input.coupon, reduced, now);
    if (!applied.ok) return applied;
    couponMinor = applied.discount;
    couponCode = input.coupon.code;
  }
  const couponShares = priced.map(() => 0);
  if (couponMinor > 0) allocateLargestRemainder(couponMinor, open.map((i) => remaining[i])).forEach((share, k) => { couponShares[open[k]] = share; });
  const shares = priced.map((p, i) => p.ruleMinor + autoLine[i] + couponShares[i]);
  const discount = ruleDiscountMinor + auto.discountMinor + couponMinor;

  const quoteLines: QuoteLine[] = priced.map((p, i) => {
    const taxable = p.gross - shares[i];
    const tax = taxOn(taxable, p.bps, inclusive);
    return {
      variantId: p.variant.id, productId: p.variant.productId, productName: p.variant.productName, sku: p.variant.sku,
      optionValues: p.variant.optionValues, hsnCode: p.variant.hsnCode, trackInventory: p.variant.trackInventory,
      codAvailable: p.variant.codAvailable !== false && !p.variant.digital, digital: p.variant.digital === true,
      preorderShipDate: p.variant.preorderShipDate ?? null, qty: p.qty, unitPriceMinor: p.unit, catalogPriceMinor: p.variant.priceMinor ?? p.unit,
      grossMinor: p.gross, discountMinor: shares[i], taxRateBps: p.bps, taxMinor: tax,
      lineTotalMinor: inclusive ? taxable : taxable + tax, gift: false, giftName: null,
    };
  });
  // Free gifts: the rule holds on the merchandise after discounts, and one more unit of the gift can be had.
  for (const rule of giftsFor(input.giftRules ?? [], subtotal - discount, new Set(priced.map((p) => p.variant.productId)), now)) {
    const v = variants.get(rule.giftVariantId);
    if (!v || !v.sellable) continue;
    const inCart = lines.find((l) => l.variantId === v.id)?.qty ?? 0;
    if (v.available !== null && v.available !== undefined && v.available < inCart + 1) continue;
    quoteLines.push({
      variantId: v.id, productId: v.productId, productName: v.productName, sku: v.sku, optionValues: v.optionValues, hsnCode: v.hsnCode,
      trackInventory: v.trackInventory, codAvailable: v.codAvailable !== false && !v.digital, digital: v.digital === true,
      preorderShipDate: v.preorderShipDate ?? null, qty: 1, unitPriceMinor: 0, catalogPriceMinor: v.priceMinor ?? 0, grossMinor: 0, discountMinor: 0,
      taxRateBps: v.taxRateBps ?? settings.defaultTaxRateBps ?? 0, taxMinor: 0, lineTotalMinor: 0, gift: true, giftName: rule.name,
    });
  }
  const lineTax = safeAdd(...quoteLines.map((l) => l.taxMinor));
  if (lineTax === null) return { ok: false, code: 'amount_out_of_range' };

  const digitalOnly = quoteLines.every((l) => l.digital);
  const deliveryMethod: DeliveryMethod = digitalOnly ? 'ship' : input.deliveryMethod ?? 'ship';
  const delivery = input.deliveryOptions ?? null;
  if (deliveryMethod === 'pickup' && !delivery?.pickupEnabled) return { ok: false, code: 'delivery_unavailable' };
  if (deliveryMethod === 'local' && !delivery?.localEnabled) return { ok: false, code: 'delivery_unavailable' };
  let shipping: Quote['shipping'] = null;
  // A zone rate can refuse cash on delivery; pickup, local delivery and digital carts have no zone rate.
  let zoneCod = true;
  if (digitalOnly) {
    // Nothing to ship: no address, no rate, no fee.
    shipping = { rateId: 'digital', name: '', feeMinor: 0, taxRateBps: 0, taxMinor: 0 };
  } else if (input.address && deliveryMethod === 'pickup') {
    // Collected at the store: nothing to ship, nothing to charge.
    shipping = { rateId: 'pickup', name: '', feeMinor: 0, taxRateBps: 0, taxMinor: 0 };
  } else if (input.address && deliveryMethod === 'local') {
    if (!localDeliveryReaches(delivery, input.address.postalCode)) return { ok: false, code: 'delivery_unavailable' };
    const fee = delivery!.localFeeMinor;
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > MAX_MINOR) return { ok: false, code: 'amount_out_of_range' };
    let bps = settings.defaultTaxRateBps;
    if (bps === null) {
      if (fee > 0 && !auto.freeShipping) return { ok: false, code: 'tax_not_configured' };
      bps = 0;
    }
    const feeMinor = auto.freeShipping ? 0 : fee;
    if (auto.freeShipping && fee > 0) autoDiscounts.push({ ...auto.freeShipping, kind: 'free_shipping_over', savingMinor: fee });
    shipping = { rateId: 'local', name: '', feeMinor, taxRateBps: bps, taxMinor: taxOn(feeMinor, bps, inclusive) };
  } else if (input.address) {
    // Cart weight from the server's own variant rows; a variant with no weight counts as 0, and a digital one weighs nothing.
    const weightGrams = priced.reduce((sum, p) => sum + (p.variant.digital ? 0 : (p.variant.weightGrams ?? 0) * p.qty), 0);
    const merchandise = subtotal - discount;
    const rate = pickShippingRate(input.shippingRates, input.address, merchandise, { weightGrams });
    if (!rate) return { ok: false, code: 'shipping_unavailable' };
    zoneCod = rate.codAllowed !== false;
    const rateFee = shippingFeeMinor(rate, weightGrams, merchandise);
    let bps = rate.taxRateBps ?? settings.defaultTaxRateBps;
    if (bps === null) {
      if (rateFee > 0 && !auto.freeShipping) return { ok: false, code: 'tax_not_configured' };
      bps = 0;
    }
    // A free-shipping rule waives the fee of the rate that would have applied.
    const feeMinor = auto.freeShipping ? 0 : rateFee;
    if (auto.freeShipping && rateFee > 0)
      autoDiscounts.push({ ...auto.freeShipping, kind: 'free_shipping_over', savingMinor: rateFee });
    shipping = { rateId: rate.id, name: rate.name, feeMinor, taxRateBps: bps, taxMinor: taxOn(feeMinor, bps, inclusive) };
  }
  const shippingMinor = shipping?.feeMinor ?? 0;

  const codAvailable = settings.codEnabled === true && zoneCod && quoteLines.every((l) => l.codAvailable);
  let codFee: Quote['codFee'] = null;
  if (paymentMethod === 'cod') {
    if (!codAvailable) return { ok: false, code: 'cod_unavailable' };
    const feeMinor = settings.codFeeMinor ?? 0;
    if (!Number.isSafeInteger(feeMinor) || feeMinor < 0 || feeMinor > MAX_MINOR) return { ok: false, code: 'amount_out_of_range' };
    let bps = settings.defaultTaxRateBps;
    if (bps === null) {
      if (feeMinor > 0) return { ok: false, code: 'tax_not_configured' };
      bps = 0;
    }
    codFee = { feeMinor, taxRateBps: bps, taxMinor: taxOn(feeMinor, bps, inclusive) };
  }
  const codFeeMinor = codFee?.feeMinor ?? 0;

  const taxMinor = safeAdd(lineTax, shipping?.taxMinor ?? 0, codFee?.taxMinor ?? 0);
  if (taxMinor === null) return { ok: false, code: 'amount_out_of_range' };
  const total = safeAdd(subtotal - discount, shippingMinor, codFeeMinor, inclusive ? 0 : taxMinor);
  if (total === null) return { ok: false, code: 'amount_out_of_range' };
  const tender = tenderFor(total, input.tender);
  return {
    ok: true,
    quote: {
      currency: settings.currency, taxInclusive: inclusive, lines: quoteLines, subtotalMinor: subtotal, discountMinor: discount,
      autoDiscountMinor: ruleDiscountMinor + auto.discountMinor, ruleDiscountMinor, autoDiscounts, prepaidSavingMinor: auto.prepaidOffer?.savingMinor ?? 0, couponCode, deliveryMethod, digitalOnly,
      preorderShipDate: quoteLines.reduce<string | null>((latest, l) => (l.preorderShipDate && (!latest || l.preorderShipDate > latest) ? l.preorderShipDate : latest), null),
      shipping, shippingMinor, paymentMethod, codAvailable, codFee, codFeeMinor, taxMinor, totalMinor: total, ...tender,
    },
  };
}
