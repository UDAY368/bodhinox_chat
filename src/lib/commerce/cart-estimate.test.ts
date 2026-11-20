import { describe, expect, it } from 'vitest';
import { buildEstimate, parseEstimateInput } from './cart-estimate';
import type { PricingResult, Quote } from './pricing';

const quote = (over: Partial<Quote>): PricingResult => ({ ok: true, quote: {
  currency: 'INR', taxInclusive: true, lines: [], subtotalMinor: 100000, discountMinor: 0, autoDiscountMinor: 0, ruleDiscountMinor: 0,
  autoDiscounts: [], prepaidSavingMinor: 0, couponCode: null, deliveryMethod: 'ship', digitalOnly: false, preorderShipDate: null,
  shipping: null, shippingMinor: 0, paymentMethod: 'online', codAvailable: true, codFee: null, codFeeMinor: 0, taxMinor: 15254,
  totalMinor: 100000, pointsRedeemed: 0, pointsValueMinor: 0, storeCreditMinor: 0, payableMinor: 100000, ...over,
} as Quote });
const base = { pincode: null, couponCode: null, couponTyped: false, couponFound: false, stateOnlyRates: false };

describe('cart page estimate', () => {
  it('reads the pincode and coupon leniently', () => {
    expect(parseEstimateInput({ pincode: '560 001', coupon: ' save10 ' })).toEqual({ pincode: '560001', couponCode: 'SAVE10', couponTyped: true });
    expect(parseEstimateInput({ pincode: '012345', coupon: '' })).toEqual({ pincode: null, couponCode: null, couponTyped: false });
    expect(parseEstimateInput({ coupon: '!' })).toMatchObject({ couponCode: null, couponTyped: true });
  });

  it('asks for a pincode before shipping is known', () => {
    const e = buildEstimate(() => quote({}), base);
    expect(e).toMatchObject({ shipping: 'needs_pincode', shippingMinor: 0, totalMinor: 100000, couponError: null });
  });

  it('prices shipping for a pincode a rate reaches', () => {
    const e = buildEstimate((_c, address) => quote(address
      ? { shipping: { rateId: 'r', name: 'Standard', feeMinor: 5000, taxRateBps: 0, taxMinor: 0 }, shippingMinor: 5000, totalMinor: 105000 } : {}),
    { ...base, pincode: '560001' });
    expect(e).toMatchObject({ shipping: 'priced', shippingMinor: 5000, totalMinor: 105000, pincode: '560001' });
  });

  it('reports a pincode no rate reaches, or one only the address can settle, and still totals the cart', () => {
    const price = (_c: boolean, address: boolean): PricingResult => (address ? { ok: false, code: 'shipping_unavailable' } : quote({}));
    expect(buildEstimate(price, { ...base, pincode: '110001' })).toMatchObject({ shipping: 'unavailable', totalMinor: 100000 });
    expect(buildEstimate(price, { ...base, pincode: '110001', stateOnlyRates: true })).toMatchObject({ shipping: 'unknown' });
  });

  it('checks a coupon without applying one that does not fit', () => {
    const fits = buildEstimate((coupon) => quote(coupon ? { couponCode: 'SAVE10', discountMinor: 10000, totalMinor: 90000 } : {}),
      { ...base, couponCode: 'SAVE10', couponTyped: true, couponFound: true });
    expect(fits).toMatchObject({ couponCode: 'SAVE10', couponMinor: 10000, couponError: null, totalMinor: 90000 });
    const expired = buildEstimate((coupon) => (coupon ? { ok: false, code: 'coupon_expired' } : quote({})),
      { ...base, couponCode: 'OLD', couponTyped: true, couponFound: true });
    expect(expired).toMatchObject({ couponCode: null, couponMinor: 0, couponError: 'coupon_expired', totalMinor: 100000 });
    expect(buildEstimate(() => quote({}), { ...base, couponCode: 'NOPE', couponTyped: true })).toMatchObject({ couponError: 'coupon_not_found' });
  });

  it('needs no shipping for downloads, and gives up when the cart cannot be priced', () => {
    expect(buildEstimate(() => quote({ digitalOnly: true }), { ...base, pincode: '560001' })).toMatchObject({ shipping: 'not_needed' });
    expect(buildEstimate(() => ({ ok: false, code: 'tax_not_configured' }), base)).toBeNull();
  });
});
