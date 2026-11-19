import { describe, expect, it } from 'vitest';
import {
  couponDiscount, normaliseCart, pickShippingRate, priceCart, quoteShippingForPincode, shippingFeeMinor, taxOn,
  type PricingCoupon, type PricingSettings, type PricingShippingRate, type PricingVariant,
} from './pricing';

const variant = (id: string, priceMinor: number | null, extra: Partial<PricingVariant> = {}): PricingVariant => ({
  id, productId: `p-${id}`, productName: `Product ${id}`, sku: `SKU-${id}`, optionValues: {}, priceMinor,
  taxRateBps: null, hsnCode: null, trackInventory: true, sellable: true, ...extra,
});
const inr = (extra: Partial<PricingSettings> = {}): PricingSettings => ({ currency: 'INR', pricesIncludeTax: true, defaultTaxRateBps: 1800, ...extra });
const rate = (extra: Partial<PricingShippingRate> = {}): PricingShippingRate => ({
  id: 'r1', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 5000,
  taxRateBps: null, position: 0, ...extra,
});
const coupon = (extra: Partial<PricingCoupon> = {}): PricingCoupon => ({
  code: 'SAVE10', kind: 'percent', value: 1000, minSubtotalMinor: 0, maxDiscountMinor: null, startsAt: null, endsAt: null,
  active: true, ...extra,
});
const address = { country: 'IN', postalCode: '560001' };

describe('taxOn', () => {
  it('rounds exclusive tax half up', () => {
    expect(taxOn(1000, 1800, false)).toBe(180);
    expect(taxOn(25, 1800, false)).toBe(5); // 4.5 -> 5
    expect(taxOn(0, 1800, false)).toBe(0);
  });
  it('extracts inclusive tax so taxable = net + tax', () => {
    // 118.00 incl. 18% = 100.00 + 18.00
    expect(taxOn(11800, 1800, true)).toBe(1800);
    expect(taxOn(49900, 1800, true)).toBe(49900 - Math.round(49900 * 10000 / 11800));
    expect(taxOn(500, 0, true)).toBe(0);
  });
});

describe('couponDiscount', () => {
  const now = new Date('2026-11-03T10:00:00Z');
  it('caps a percent discount at max_discount and the subtotal', () => {
    expect(couponDiscount(coupon(), 10005, now)).toEqual({ ok: true, discount: 1001 }); // 1000.5 -> 1001
    expect(couponDiscount(coupon({ maxDiscountMinor: 500 }), 10000, now)).toEqual({ ok: true, discount: 500 });
    expect(couponDiscount(coupon({ kind: 'fixed', value: 99999 }), 1000, now)).toEqual({ ok: true, discount: 1000 });
  });
  it('refuses inactive, early, ended and below-minimum coupons', () => {
    expect(couponDiscount(coupon({ active: false }), 1000, now)).toEqual({ ok: false, code: 'coupon_inactive' });
    expect(couponDiscount(coupon({ startsAt: new Date('2026-11-04') }), 1000, now)).toEqual({ ok: false, code: 'coupon_not_started' });
    expect(couponDiscount(coupon({ endsAt: now }), 1000, now)).toEqual({ ok: false, code: 'coupon_expired' });
    expect(couponDiscount(coupon({ minSubtotalMinor: 2000 }), 1000, now)).toEqual({ ok: false, code: 'coupon_min_subtotal' });
  });
});

describe('pickShippingRate', () => {
  it('prefers the longest postal prefix, then position, then fee', () => {
    const rates = [rate({ id: 'all' }), rate({ id: 'blr', postalPrefixes: ['56'] }), rate({ id: 'cbd', postalPrefixes: ['5600'] })];
    expect(pickShippingRate(rates, address, 100)?.id).toBe('cbd');
    expect(pickShippingRate(rates, { country: 'IN', postalCode: '110001' }, 100)?.id).toBe('all');
    expect(pickShippingRate([rate({ id: 'a', position: 2 }), rate({ id: 'b', position: 1 })], address, 0)?.id).toBe('b');
    expect(pickShippingRate([rate({ id: 'a', feeMinor: 9 }), rate({ id: 'b', feeMinor: 3 })], address, 0)?.id).toBe('b');
  });
  it('respects the country and subtotal band', () => {
    expect(pickShippingRate([rate({ country: 'US' })], address, 0)).toBeNull();
    expect(pickShippingRate([rate({ minSubtotalMinor: 500 })], address, 499)).toBeNull();
    expect(pickShippingRate([rate({ maxSubtotalMinor: 500 })], address, 501)).toBeNull();
  });
});

describe('zones, weight slabs and the free threshold', () => {
  const mh = { country: 'IN', postalCode: '411001', state: 'Maharashtra', stateCode: 'MH' };
  const zones = [
    rate({ id: 'all', name: 'Rest of India', feeMinor: 9000 }),
    rate({ id: 'state', name: 'Maharashtra', states: ['MH'], feeMinor: 6000 }),
    rate({ id: 'metro', name: 'Pune', postalPrefixes: ['4110'], feeMinor: 3000 }),
    rate({ id: 'city', name: 'Pune 1', postalPrefixes: ['41100'], feeMinor: 2000 }),
  ];
  it('longest prefix beats a shorter prefix, a state and the catch-all', () => {
    expect(pickShippingRate(zones, mh, 100)?.id).toBe('city');
    expect(pickShippingRate(zones, { ...mh, postalCode: '411045' }, 100)?.id).toBe('metro');
    expect(pickShippingRate(zones, { ...mh, postalCode: '400001' }, 100)?.id).toBe('state');
    expect(pickShippingRate(zones, { country: 'IN', postalCode: '560001', state: 'Karnataka', stateCode: 'KA' }, 100)?.id).toBe('all');
  });
  it('matches a state by name or code, ignoring case and spacing', () => {
    const r = [rate({ id: 'tn', states: ['TAMIL NADU'] })];
    expect(pickShippingRate(r, { country: 'IN', postalCode: '600001', state: 'tamil  nadu' }, 0)?.id).toBe('tn');
    expect(pickShippingRate(r, { country: 'IN', postalCode: '600001', state: 'Kerala', stateCode: 'KL' }, 0)).toBeNull();
    expect(pickShippingRate(r, { country: 'IN', postalCode: '600001' }, 0)).toBeNull();
  });
  it('with only zone rates and no catch-all, an uncovered address is not deliverable', () => {
    const only = zones.filter((z) => z.id !== 'all');
    expect(quoteShippingForPincode(only, { pincode: '560001', state: 'Karnataka' })).toEqual({ deliverable: false, priceMinor: 0, cod: false, rateName: null });
    expect(quoteShippingForPincode(only, { pincode: '411001' })).toMatchObject({ deliverable: true, priceMinor: 2000, rateName: 'Pune 1' });
  });
  it('charges the slab: base covers the first grams, then each started step', () => {
    const slab = rate({ feeMinor: 4000, baseWeightGrams: 500, stepGrams: 500, extraPerStepMinor: 1500 });
    expect(shippingFeeMinor(slab, 0, 0)).toBe(4000);
    expect(shippingFeeMinor(slab, 500, 0)).toBe(4000);
    expect(shippingFeeMinor(slab, 501, 0)).toBe(5500);
    expect(shippingFeeMinor(slab, 1500, 0)).toBe(7000);
    expect(shippingFeeMinor(slab, 1501, 0)).toBe(8500);
  });
  it('skips a rate whose weight limit the cart exceeds', () => {
    const rs = [rate({ id: 'light', maxWeightGrams: 1000, feeMinor: 1000 }), rate({ id: 'heavy', feeMinor: 8000, position: 1 })];
    expect(pickShippingRate(rs, address, 0, { weightGrams: 1000 })?.id).toBe('light');
    expect(pickShippingRate(rs, address, 0, { weightGrams: 1001 })?.id).toBe('heavy');
    expect(pickShippingRate([rs[0]], address, 0, { weightGrams: 1001 })).toBeNull();
  });
  it('is free once the merchandise reaches the threshold, and not before', () => {
    const r = rate({ freeOverMinor: 100000 });
    expect(shippingFeeMinor(r, 0, 99999)).toBe(5000);
    expect(shippingFeeMinor(r, 0, 100000)).toBe(0);
    expect(quoteShippingForPincode([r], { pincode: '560001', subtotalMinor: 100000 })).toMatchObject({ priceMinor: 0 });
  });
  it('reports the zone COD flag; rows without the new fields behave as before', () => {
    expect(quoteShippingForPincode([rate({ codAllowed: false })], { pincode: '560001' }).cod).toBe(false);
    expect(quoteShippingForPincode([rate()], { pincode: '560001' })).toEqual({ deliverable: true, priceMinor: 5000, cod: true, rateName: 'India' });
    expect(shippingFeeMinor(rate(), 99999, 0)).toBe(5000);
  });
  it('priceCart weighs the cart on the server, applies the slab after discounts, and honours the zone COD switch', () => {
    const rs = [rate({ feeMinor: 4000, baseWeightGrams: 500, stepGrams: 500, extraPerStepMinor: 1500, freeOverMinor: 50000, taxRateBps: 0, codAllowed: false })];
    const run = (qty: number, extra: Record<string, unknown> = {}) => priceCart({
      lines: [{ variantId: 'a', qty }], variants: [variant('a', 10000, { weightGrams: 400 })], settings: inr({ codEnabled: true }),
      shippingRates: rs, coupon: null, address, ...extra,
    });
    const two = run(2); // 800 g -> one extra step
    expect(two.ok && two.quote.shippingMinor).toBe(5500);
    expect(two.ok && two.quote.codAvailable).toBe(false);
    const heavy = run(4); // 1600 g, but 40000 is below the 50000 threshold: 3 extra steps
    expect(heavy.ok && heavy.quote.shippingMinor).toBe(8500);
    const free = run(5); // 2000 g, 50000 reaches the threshold
    expect(free.ok && free.quote.shippingMinor).toBe(0);
    const afterCoupon = run(5, { coupon: coupon({ kind: 'fixed', value: 1000 }) }); // 49000 after the coupon: not free
    expect(afterCoupon.ok && afterCoupon.quote.shippingMinor).toBe(4000 + 1500 * 3);
    expect(run(2, { paymentMethod: 'cod' })).toEqual({ ok: false, code: 'cod_unavailable' });
  });
  it('a variant with no weight counts as 0', () => {
    const r = priceCart({ lines: [{ variantId: 'a', qty: 3 }], variants: [variant('a', 100)], settings: inr(),
      shippingRates: [rate({ feeMinor: 4000, baseWeightGrams: 0, stepGrams: 100, extraPerStepMinor: 1000 })], coupon: null, address });
    expect(r.ok && r.quote.shippingMinor).toBe(4000);
  });
});

describe('normaliseCart', () => {
  it('merges repeated variants and refuses bad quantities', () => {
    expect(normaliseCart([{ variantId: 'a', qty: 1 }, { variantId: 'b', qty: 2 }, { variantId: 'a', qty: 3 }]))
      .toEqual([{ variantId: 'a', qty: 4 }, { variantId: 'b', qty: 2 }]);
    expect(normaliseCart([{ variantId: 'a', qty: 0 }])).toBeNull();
    expect(normaliseCart([{ variantId: 'a', qty: 60 }, { variantId: 'a', qty: 60 }])).toBeNull();
    expect(normaliseCart(Array.from({ length: 51 }, (_, i) => ({ variantId: `v${i}`, qty: 1 })))).toBeNull();
  });
});

describe('priceCart', () => {
  it('prices an inclusive cart with a coupon and shipping so the total equals its parts', () => {
    const result = priceCart({
      lines: [{ variantId: 'a', qty: 2 }, { variantId: 'b', qty: 1 }],
      variants: [variant('a', 49900), variant('b', 30000, { taxRateBps: 500 })],
      settings: inr(), shippingRates: [rate()], coupon: coupon({ kind: 'fixed', value: 10000 }), address,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const q = result.quote;
    expect(q.subtotalMinor).toBe(129800);
    expect(q.discountMinor).toBe(10000);
    expect(q.lines.reduce((s, l) => s + l.discountMinor, 0)).toBe(10000);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([7689, 2311]); // largest remainder on 99800 / 30000
    expect(q.shippingMinor).toBe(5000);
    expect(q.totalMinor).toBe(129800 - 10000 + 5000);
    expect(q.taxMinor).toBe(q.lines.reduce((s, l) => s + l.taxMinor, 0) + (q.shipping?.taxMinor ?? 0));
    expect(q.lines.reduce((s, l) => s + l.lineTotalMinor, 0)).toBe(q.subtotalMinor - q.discountMinor);
  });

  it('adds tax on top when prices exclude it', () => {
    const result = priceCart({
      lines: [{ variantId: 'a', qty: 3 }], variants: [variant('a', 333)], settings: inr({ pricesIncludeTax: false }),
      shippingRates: [rate({ feeMinor: 100, taxRateBps: 0 })], coupon: null, address,
    });
    expect(result.ok && result.quote).toMatchObject({ subtotalMinor: 999, taxMinor: 180, shippingMinor: 100, totalMinor: 999 + 100 + 180 });
  });

  it('allocates ties to the lower line index', () => {
    const result = priceCart({
      lines: [{ variantId: 'a', qty: 1 }, { variantId: 'b', qty: 1 }, { variantId: 'c', qty: 1 }],
      variants: [variant('a', 100), variant('b', 100), variant('c', 100)], settings: inr({ defaultTaxRateBps: 0 }),
      shippingRates: [], coupon: coupon({ kind: 'fixed', value: 100 }), address: null,
    });
    expect(result.ok && result.quote.lines.map((l) => l.discountMinor)).toEqual([34, 33, 33]);
  });

  it('works in currencies with 0 and 3 minor digits', () => {
    for (const currency of ['JPY', 'KWD']) {
      const result = priceCart({
        lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 1500)], settings: inr({ currency, pricesIncludeTax: false, defaultTaxRateBps: 1000 }),
        shippingRates: [], coupon: null, address: null,
      });
      expect(result.ok && result.quote).toMatchObject({ currency, taxMinor: 150, totalMinor: 1650, shipping: null });
    }
  });

  it('refuses instead of assuming a price, a tax rate or shipping', () => {
    const base = { settings: inr(), shippingRates: [rate()], coupon: null, address };
    expect(priceCart({ ...base, lines: [], variants: [] })).toEqual({ ok: false, code: 'cart_empty' });
    expect(priceCart({ ...base, lines: [{ variantId: 'x', qty: 1 }], variants: [] })).toEqual({ ok: false, code: 'variant_unavailable', variantId: 'x' });
    expect(priceCart({ ...base, lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 100, { sellable: false })] }))
      .toEqual({ ok: false, code: 'variant_unavailable', variantId: 'a' });
    expect(priceCart({ ...base, lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', null)] }))
      .toEqual({ ok: false, code: 'price_not_configured', variantId: 'a' });
    expect(priceCart({ ...base, settings: inr({ defaultTaxRateBps: null }), lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 100)] }))
      .toEqual({ ok: false, code: 'tax_not_configured', variantId: 'a' });
    // An explicit 0 rate is configured; a paid shipping fee needs a rate too.
    expect(priceCart({ ...base, settings: inr({ defaultTaxRateBps: null }), lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 100, { taxRateBps: 0 })] }))
      .toEqual({ ok: false, code: 'tax_not_configured' });
    expect(priceCart({ ...base, shippingRates: [], lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 100)] }))
      .toEqual({ ok: false, code: 'shipping_unavailable' });
    expect(priceCart({ ...base, coupon: 'missing', lines: [{ variantId: 'a', qty: 1 }], variants: [variant('a', 100)] }))
      .toEqual({ ok: false, code: 'coupon_not_found' });
    expect(priceCart({ ...base, lines: [{ variantId: 'a', qty: 99 }], variants: [variant('a', Number.MAX_SAFE_INTEGER)] }))
      .toEqual({ ok: false, code: 'amount_out_of_range' });
  });
});

describe('priceCart cash on delivery', () => {
  const base = {
    lines: [{ variantId: 'a', qty: 2 }], variants: [variant('a', 10000)], shippingRates: [rate({ feeMinor: 5000, taxRateBps: 0 })],
    coupon: null, address,
  };
  const cod = (settings: Partial<PricingSettings>, extra: Record<string, unknown> = {}) =>
    priceCart({ ...base, settings: inr({ codEnabled: true, codFeeMinor: 4000, ...settings }), paymentMethod: 'cod', ...extra });

  it('online by default: no fee, and codAvailable reports whether COD could be chosen', () => {
    const online = priceCart({ ...base, settings: inr({ codEnabled: true, codFeeMinor: 4000 }) });
    expect(online.ok && online.quote).toMatchObject({ paymentMethod: 'online', codAvailable: true, codFee: null, codFeeMinor: 0, totalMinor: 25000 });
    const off = priceCart({ ...base, settings: inr() });
    expect(off.ok && off.quote.codAvailable).toBe(false);
  });

  it('adds the fee, taxed like shipping, inclusive and exclusive', () => {
    const inclusive = cod({});
    expect(inclusive.ok && inclusive.quote).toMatchObject({
      paymentMethod: 'cod', codFeeMinor: 4000, codFee: { feeMinor: 4000, taxRateBps: 1800, taxMinor: taxOn(4000, 1800, true) },
      totalMinor: 20000 + 5000 + 4000,
    });
    if (inclusive.ok) expect(inclusive.quote.taxMinor)
      .toBe(inclusive.quote.lines.reduce((s, l) => s + l.taxMinor, 0) + (inclusive.quote.codFee?.taxMinor ?? 0));
    const exclusive = cod({ pricesIncludeTax: false });
    // 20000 goods + 3600 tax, 5000 shipping at 0 %, 4000 fee + 720 tax.
    expect(exclusive.ok && exclusive.quote).toMatchObject({ taxMinor: 3600 + 720, totalMinor: 20000 + 5000 + 4000 + 3600 + 720 });
  });

  it('keeps the fee out of the coupon minimum, the discount and the shipping band', () => {
    const result = cod({}, {
      coupon: coupon({ kind: 'percent', value: 5000, minSubtotalMinor: 20000 }),
      shippingRates: [rate({ id: 'small', maxSubtotalMinor: 10000, feeMinor: 0 }), rate({ id: 'big', minSubtotalMinor: 10001, feeMinor: 700, taxRateBps: 0 })],
    });
    expect(result.ok && result.quote).toMatchObject({ discountMinor: 10000, shipping: { rateId: 'small' }, codFeeMinor: 4000, totalMinor: 10000 + 0 + 4000 });
  });

  it('a zero fee needs no tax rate; a positive fee does', () => {
    expect(cod({ codFeeMinor: 0, defaultTaxRateBps: null }, { variants: [variant('a', 10000, { taxRateBps: 500 })] }))
      .toMatchObject({ ok: true, quote: { codFeeMinor: 0, codFee: { feeMinor: 0, taxRateBps: 0, taxMinor: 0 } } });
    expect(cod({ defaultTaxRateBps: null }, { variants: [variant('a', 10000, { taxRateBps: 500 })] }))
      .toEqual({ ok: false, code: 'tax_not_configured' });
  });

  it('refuses COD when the store has it off or any product opts out', () => {
    expect(cod({ codEnabled: false })).toEqual({ ok: false, code: 'cod_unavailable' });
    const mixed = cod({}, {
      lines: [{ variantId: 'a', qty: 1 }, { variantId: 'b', qty: 1 }],
      variants: [variant('a', 10000), variant('b', 10000, { codAvailable: false })],
    });
    expect(mixed).toEqual({ ok: false, code: 'cod_unavailable' });
    const online = priceCart({ ...base, settings: inr({ codEnabled: true }), lines: [{ variantId: 'b', qty: 1 }],
      variants: [variant('b', 10000, { codAvailable: false })] });
    expect(online.ok && online.quote).toMatchObject({ codAvailable: false, lines: [{ codAvailable: false }] });
  });
});
