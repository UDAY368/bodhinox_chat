/**
 * The cart page's estimate (store plan, batch 6): an anonymous price for the
 * browser cart before the buyer gives a number. Lines, an optional pincode and
 * an optional coupon code in; subtotal, automatic discounts, the coupon's
 * saving, shipping, tax and total out, priced by the same priceCart the
 * checkout uses with this workspace's own settings, rates and rules.
 *
 * Read-only: no contact, no session, nothing reserved. The coupon is looked up
 * and checked, never redeemed; per-buyer limits, buyer price lists and the
 * shipping for the full address are worked out again at checkout, so the page
 * labels this an estimate. The pincode and code are never stored or logged.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { loadAutoDiscountsTx } from './auto-discount-rules';
import { findCouponTx, normaliseCouponCode, toPricingCoupon } from './coupons';
import { hasStateOnlyRate, parsePincode } from './pincode';
import { loadBuyerPricingTx } from './price-rules-store';
import { priceCart, type CartLine, type PricingCoupon, type PricingResult } from './pricing';
import { loadPricingSettings, pricingRate, selectRates } from './store-settings';
import { loadVariants } from './storefront';

/** How shipping stands in the estimate. */
export type EstimateShipping =
  | 'priced' // a rate matched the pincode (shippingMinor may be 0 = free)
  | 'needs_pincode' // no pincode yet: shipping is added at the address step
  | 'unknown' // only a state-wide rate could match: the address decides
  | 'unavailable' // no rate reaches this pincode
  | 'not_needed'; // a cart of only downloads

export interface CartEstimate {
  currency: string;
  taxInclusive: boolean;
  subtotalMinor: number;
  autoDiscounts: Array<{ name: string; kind: string; savingMinor: number }>;
  /** The applied coupon and what it saves; null when none applies. */
  couponCode: string | null;
  couponMinor: number;
  /** Why the typed code does not apply (coupon_not_found, coupon_expired, coupon_min_subtotal …); null when it does or none was typed. */
  couponError: string | null;
  pincode: string | null;
  shipping: EstimateShipping;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface EstimateInput { pincode: string | null; couponCode: string | null; couponTyped: boolean }

/** The optional pincode and coupon of a cart request. A malformed pincode is ignored; a malformed code is "not found". */
export function parseEstimateInput(body: Record<string, unknown>): EstimateInput {
  const typed = typeof body.coupon === 'string' && body.coupon.trim() !== '';
  return { pincode: parsePincode(body.pincode), couponCode: typed ? normaliseCouponCode(body.coupon) : null, couponTyped: typed };
}

/**
 * The estimate from a pricing callback (`withCoupon`, `withAddress`): a coupon that does not apply is reported and
 * priced without, a pincode no rate reaches is reported and priced without an address. Null when the cart itself
 * cannot be priced (the cart page then shows the subtotal only).
 */
export function buildEstimate(price: (withCoupon: boolean, withAddress: boolean) => PricingResult,
  input: EstimateInput & { couponFound: boolean; stateOnlyRates: boolean }): CartEstimate | null {
  let couponError: string | null = input.couponTyped && (!input.couponCode || !input.couponFound) ? 'coupon_not_found' : null;
  let useCoupon = input.couponFound && couponError === null;
  let useAddress = input.pincode !== null;
  let shipping: EstimateShipping | null = null;
  let result = price(useCoupon, useAddress);
  if (!result.ok && result.code.startsWith('coupon_') && useCoupon) {
    couponError = result.code;
    useCoupon = false;
    result = price(useCoupon, useAddress);
  }
  if (!result.ok && result.code === 'shipping_unavailable' && useAddress) {
    shipping = input.stateOnlyRates ? 'unknown' : 'unavailable';
    useAddress = false;
    result = price(useCoupon, useAddress);
  }
  if (!result.ok) return null;
  const q = result.quote;
  if (q.digitalOnly) shipping = 'not_needed';
  else if (!shipping) shipping = useAddress && q.shipping ? 'priced' : 'needs_pincode';
  return {
    currency: q.currency, taxInclusive: q.taxInclusive, subtotalMinor: q.subtotalMinor,
    autoDiscounts: q.autoDiscounts.map((d) => ({ name: d.name, kind: d.kind, savingMinor: d.savingMinor })),
    couponCode: useCoupon ? q.couponCode : null, couponMinor: useCoupon ? q.discountMinor - q.autoDiscountMinor : 0, couponError,
    pincode: input.pincode, shipping, shippingMinor: shipping === 'priced' ? q.shippingMinor : 0, taxMinor: q.taxMinor, totalMinor: q.totalMinor,
  };
}

/** Price the browser cart for an anonymous visitor, inside the shop's tenant (inShopTenant). Reads only. */
export async function estimateCartTx(tx: TenantTransaction, accountId: string, lines: CartLine[], input: EstimateInput): Promise<CartEstimate | null> {
  const settings = await loadPricingSettings(tx, accountId);
  if (!settings || !lines.length) return null;
  const coupon = input.couponCode ? await findCouponTx(tx, accountId, input.couponCode) : null;
  // No buyer yet: only the rules that reach everyone (no group price lists), and the shop's gift rules.
  const buyer = await loadBuyerPricingTx(tx, accountId, null, lines.map((l) => l.variantId));
  const variants = await loadVariants(tx, accountId, [...lines.map((l) => l.variantId), ...buyer.giftRules.map((g) => g.giftVariantId)]);
  const autoDiscounts = await loadAutoDiscountsTx(tx, accountId);
  const rates = input.pincode ? (await selectRates(tx, accountId, true)).map(pricingRate) : [];
  const pricingCoupon: PricingCoupon | null = coupon ? toPricingCoupon(coupon) : null;
  return buildEstimate((withCoupon, withAddress) => priceCart({
    lines, variants, settings, shippingRates: rates,
    coupon: withCoupon ? pricingCoupon : null,
    address: withAddress && input.pincode ? { country: 'IN', postalCode: input.pincode } : null,
    paymentMethod: 'online', deliveryMethod: 'ship', deliveryOptions: null, autoDiscounts,
    priceTiers: buyer.priceTiers, lineRules: buyer.lineRules, giftRules: buyer.giftRules, tender: null,
  }), { ...input, couponFound: coupon !== null, stateOnlyRates: hasStateOnlyRate(rates) });
}
