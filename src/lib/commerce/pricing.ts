/**
 * Server pricing (design E2, E3, E4). Pure: the caller loads the variants,
 * settings, shipping rates and coupon inside its tenant transaction and this
 * module does the arithmetic. Every amount is an integer count of minor units
 * of the store currency; nothing here ever touches a float.
 *
 * Order of operations (E4):
 *  1. line_gross = unit × qty, subtotal = Σ line_gross
 *  2. coupon discount on merchandise only (percent: min(round(subtotal × bps),
 *     max_discount, subtotal); fixed: min(value, subtotal))
 *  3. the discount is split across lines by largest remainder on line_gross
 *  4. taxable = line_gross − line_discount; exclusive tax = round(taxable × bps);
 *     inclusive tax = taxable − round(taxable × 10000 / (10000 + bps))
 *  5. shipping is taxed the same way at its own rate; a cash-on-delivery (COD)
 *     fee is taxed like shipping at the store's default rate
 *  6. total = subtotal − discount + shipping + cod_fee + (inclusive ? 0 : tax_total)
 *
 * The COD fee is never discounted and never counts toward a coupon minimum or
 * a shipping band: those read the merchandise amount only.
 *
 * Refusals are codes, never guesses: an unpriced line, a needed tax rate that
 * is not configured, or no matching shipping rate refuses instead of
 * assuming zero (PRD :121).
 */
import { allocateLargestRemainder, MAX_MINOR, mulDivHalfUp, roundHalfUp } from './money';

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
  | 'cod_unavailable';

export type PaymentMethod = 'online' | 'cod';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['online', 'cod'];
export const isPaymentMethod = (value: unknown): value is PaymentMethod => value === 'online' || value === 'cod';

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
  qty: number;
  unitPriceMinor: number;
  grossMinor: number;
  discountMinor: number;
  taxRateBps: number;
  taxMinor: number;
  /** What the line costs the customer: taxable, plus tax when prices exclude it. */
  lineTotalMinor: number;
}

export interface Quote {
  currency: string;
  taxInclusive: boolean;
  lines: QuoteLine[];
  subtotalMinor: number;
  discountMinor: number;
  couponCode: string | null;
  /** null until an address is known (a quote without shipping cannot be placed). */
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

/**
 * The shipping rate for an address and merchandise amount (after discount):
 * the longest matching postal prefix wins (an empty list matches the whole
 * country with length 0), then the lower position, then the lower fee.
 */
export function pickShippingRate(rates: readonly PricingShippingRate[], address: PricingAddress, merchandiseMinor: number): PricingShippingRate | null {
  const code = postal(address.postalCode);
  let best: { rate: PricingShippingRate; specificity: number } | null = null;
  for (const rate of rates) {
    if (rate.country !== address.country.toUpperCase()) continue;
    if (merchandiseMinor < rate.minSubtotalMinor) continue;
    if (rate.maxSubtotalMinor !== null && merchandiseMinor > rate.maxSubtotalMinor) continue;
    let specificity = -1;
    if (!rate.postalPrefixes.length) specificity = 0;
    else for (const prefix of rate.postalPrefixes) if (code.startsWith(prefix)) specificity = Math.max(specificity, prefix.length);
    if (specificity < 0) continue;
    if (!best || specificity > best.specificity
      || (specificity === best.specificity && (rate.position < best.rate.position
        || (rate.position === best.rate.position && rate.feeMinor < best.rate.feeMinor))))
      best = { rate, specificity };
  }
  return best?.rate ?? null;
}

function safeAdd(...values: number[]): number | null {
  let sum = BigInt(0);
  for (const v of values) sum += BigInt(v);
  return sum > BigInt(MAX_MINOR) || sum < BigInt(0) ? null : Number(sum);
}

/** Price a cart (E2-E4). Never throws for bad business input: refusals come back as codes. */
export function priceCart(input: PriceCartInput): PricingResult {
  const now = input.now ?? new Date();
  const lines = normaliseCart(input.lines);
  if (!lines) return { ok: false, code: 'invalid_cart' };
  if (!lines.length) return { ok: false, code: 'cart_empty' };
  const variants = input.variants instanceof Map ? input.variants : new Map((input.variants as PricingVariant[]).map((v) => [v.id, v]));
  const { settings } = input;
  const inclusive = settings.pricesIncludeTax;

  const priced: Array<{ variant: PricingVariant; qty: number; unit: number; gross: number; bps: number }> = [];
  for (const line of lines) {
    const variant = variants.get(line.variantId);
    if (!variant || !variant.sellable) return { ok: false, code: 'variant_unavailable', variantId: line.variantId };
    if (variant.priceMinor === null) return { ok: false, code: 'price_not_configured', variantId: line.variantId };
    const bps = variant.taxRateBps ?? settings.defaultTaxRateBps;
    if (bps === null) return { ok: false, code: 'tax_not_configured', variantId: line.variantId };
    const gross = BigInt(variant.priceMinor) * BigInt(line.qty);
    if (gross > BigInt(MAX_MINOR)) return { ok: false, code: 'amount_out_of_range' };
    priced.push({ variant, qty: line.qty, unit: variant.priceMinor, gross: Number(gross), bps });
  }
  const subtotal = safeAdd(...priced.map((p) => p.gross));
  if (subtotal === null) return { ok: false, code: 'amount_out_of_range' };

  let discount = 0;
  let couponCode: string | null = null;
  if (input.coupon === 'missing') return { ok: false, code: 'coupon_not_found' };
  if (input.coupon) {
    const applied = couponDiscount(input.coupon, subtotal, now);
    if (!applied.ok) return applied;
    discount = applied.discount;
    couponCode = input.coupon.code;
  }
  const shares = discount > 0 ? allocateLargestRemainder(discount, priced.map((p) => p.gross)) : priced.map(() => 0);

  const quoteLines: QuoteLine[] = priced.map((p, i) => {
    const taxable = p.gross - shares[i];
    const tax = taxOn(taxable, p.bps, inclusive);
    return {
      variantId: p.variant.id, productId: p.variant.productId, productName: p.variant.productName, sku: p.variant.sku,
      optionValues: p.variant.optionValues, hsnCode: p.variant.hsnCode, trackInventory: p.variant.trackInventory,
      codAvailable: p.variant.codAvailable !== false, qty: p.qty, unitPriceMinor: p.unit, grossMinor: p.gross, discountMinor: shares[i], taxRateBps: p.bps, taxMinor: tax,
      lineTotalMinor: inclusive ? taxable : taxable + tax,
    };
  });
  const lineTax = safeAdd(...quoteLines.map((l) => l.taxMinor));
  if (lineTax === null) return { ok: false, code: 'amount_out_of_range' };

  let shipping: Quote['shipping'] = null;
  if (input.address) {
    const rate = pickShippingRate(input.shippingRates, input.address, subtotal - discount);
    if (!rate) return { ok: false, code: 'shipping_unavailable' };
    let bps = rate.taxRateBps ?? settings.defaultTaxRateBps;
    if (bps === null) {
      if (rate.feeMinor > 0) return { ok: false, code: 'tax_not_configured' };
      bps = 0;
    }
    shipping = { rateId: rate.id, name: rate.name, feeMinor: rate.feeMinor, taxRateBps: bps, taxMinor: taxOn(rate.feeMinor, bps, inclusive) };
  }
  const shippingMinor = shipping?.feeMinor ?? 0;

  const paymentMethod: PaymentMethod = input.paymentMethod ?? 'online';
  const codAvailable = settings.codEnabled === true && quoteLines.every((l) => l.codAvailable);
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
  return {
    ok: true,
    quote: {
      currency: settings.currency, taxInclusive: inclusive, lines: quoteLines, subtotalMinor: subtotal, discountMinor: discount,
      couponCode, shipping, shippingMinor, paymentMethod, codAvailable, codFee, codFeeMinor, taxMinor, totalMinor: total,
    },
  };
}
