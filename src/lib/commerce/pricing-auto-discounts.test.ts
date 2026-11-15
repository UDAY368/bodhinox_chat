import { describe, expect, it } from 'vitest';
import type { PricingAutoDiscount } from './auto-discounts';
import {
  priceCart, taxOn, type PriceCartInput, type PricingCoupon, type PricingSettings, type PricingShippingRate, type PricingVariant, type Quote,
} from './pricing';

// Automatic discounts inside priceCart (store plan Phase 3): they apply before
// the coupon, sit on the lines, and keep the order invariants receipts rely on.
const NOW = new Date('2026-11-28T10:00:00Z');
const variant = (id: string, priceMinor: number, extra: Partial<PricingVariant> = {}): PricingVariant => ({
  id, productId: `p-${id}`, productName: `Product ${id}`, sku: `SKU-${id}`, optionValues: {}, priceMinor,
  taxRateBps: null, hsnCode: null, trackInventory: true, sellable: true, ...extra,
});
const settings = (extra: Partial<PricingSettings> = {}): PricingSettings => ({
  currency: 'INR', pricesIncludeTax: false, defaultTaxRateBps: 1800, codEnabled: true, codFeeMinor: 4_900, ...extra,
});
const rate = (extra: Partial<PricingShippingRate> = {}): PricingShippingRate => ({
  id: 'r1', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 5_000,
  taxRateBps: null, position: 0, ...extra,
});
const coupon = (extra: Partial<PricingCoupon> = {}): PricingCoupon => ({
  code: 'SAVE10', kind: 'percent', value: 1_000, minSubtotalMinor: 0, maxDiscountMinor: null, startsAt: null, endsAt: null, active: true, ...extra,
});
const rule = (id: string, kind: PricingAutoDiscount['kind'], extra: Partial<PricingAutoDiscount> = {}): PricingAutoDiscount => ({
  id, name: `Rule ${id}`, kind, minSubtotalMinor: 0, amountMinor: null, percentBps: null, buyQty: null, getQty: null, productIds: [],
  active: true, startsAt: null, endsAt: null, ...extra,
});
const address = { country: 'IN', postalCode: '560001' };
const VARIANTS = [variant('a', 10_000), variant('b', 5_000)];
const CART = [{ variantId: 'a', qty: 2 }, { variantId: 'b', qty: 1 }]; // subtotal 25000

function price(extra: Partial<PriceCartInput> = {}): Quote {
  const result = priceCart({ lines: CART, variants: VARIANTS, settings: settings(), shippingRates: [rate()], coupon: null, address: null, now: NOW, ...extra });
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.quote;
}

/** The invariants every quote must keep, whatever discounts applied. */
function assertInvariants(q: Quote) {
  expect(q.lines.reduce((s, l) => s + l.discountMinor, 0)).toBe(q.discountMinor);
  expect(q.autoDiscountMinor).toBeLessThanOrEqual(q.discountMinor);
  expect(q.discountMinor).toBeLessThanOrEqual(q.subtotalMinor);
  expect(q.autoDiscounts.filter((d) => d.kind !== 'free_shipping_over').reduce((s, d) => s + d.savingMinor, 0)).toBe(q.autoDiscountMinor);
  for (const l of q.lines) {
    expect(l.discountMinor).toBeGreaterThanOrEqual(0);
    expect(l.discountMinor).toBeLessThanOrEqual(l.grossMinor);
    // Tax is worked out on the amount after the discount.
    expect(l.taxMinor).toBe(taxOn(l.grossMinor - l.discountMinor, l.taxRateBps, q.taxInclusive));
    expect(l.lineTotalMinor).toBe(l.grossMinor - l.discountMinor + (q.taxInclusive ? 0 : l.taxMinor));
  }
  expect(q.totalMinor).toBe(q.subtotalMinor - q.discountMinor + q.shippingMinor + q.codFeeMinor + (q.taxInclusive ? 0 : q.taxMinor));
  // The total never goes below shipping plus fees.
  expect(q.totalMinor).toBeGreaterThanOrEqual(q.shippingMinor + q.codFeeMinor);
}

describe('priceCart with automatic discounts', () => {
  it('prices exactly as before when there are no rules', () => {
    const without = price({ coupon: coupon(), address });
    const empty = price({ coupon: coupon(), address, autoDiscounts: [] });
    expect(empty).toEqual(without);
    expect(without).toMatchObject({ discountMinor: 2_500, autoDiscountMinor: 0, autoDiscounts: [], prepaidSavingMinor: 0 });
    expect(without.lines.map((l) => l.discountMinor)).toEqual([2_000, 500]);
    assertInvariants(without);
  });

  it('applies the automatic discount first and the coupon on the reduced subtotal (tax-exclusive prices)', () => {
    const q = price({ autoDiscounts: [rule('a', 'percent_off_over', { percentBps: 1_000 })], coupon: coupon() });
    // 10% of 25000 = 2500; the coupon's 10% then reads 22500 = 2250.
    expect(q.autoDiscountMinor).toBe(2_500);
    expect(q.discountMinor).toBe(4_750);
    expect(q.autoDiscounts).toEqual([{ id: 'a', name: 'Rule a', kind: 'percent_off_over', savingMinor: 2_500 }]);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([3_800, 950]);
    // 18% on 16200 and on 4050, added on top.
    expect(q.lines.map((l) => l.taxMinor)).toEqual([2_916, 729]);
    expect(q.totalMinor).toBe(25_000 - 4_750 + 3_645);
    assertInvariants(q);
  });

  it('works out tax after the discount for tax-inclusive prices too', () => {
    const q = price({
      settings: settings({ pricesIncludeTax: true }), autoDiscounts: [rule('a', 'percent_off_over', { percentBps: 1_000 })], coupon: coupon(),
    });
    expect(q.lines.map((l) => l.discountMinor)).toEqual([3_800, 950]);
    // Tax inside 16200 and inside 4050 at 18%.
    expect(q.lines.map((l) => l.taxMinor)).toEqual([2_471, 618]);
    expect(q.totalMinor).toBe(20_250);
    assertInvariants(q);
  });

  it('checks the coupon minimum against the reduced subtotal', () => {
    const input = { lines: CART, variants: VARIANTS, settings: settings(), shippingRates: [], address: null, now: NOW, coupon: coupon({ minSubtotalMinor: 24_000 }) };
    expect(priceCart(input).ok).toBe(true);
    expect(priceCart({ ...input, autoDiscounts: [rule('a', 'amount_off_over', { amountMinor: 2_500 })] })).toEqual({ ok: false, code: 'coupon_min_subtotal' });
  });

  it('applies only the best order-level rule', () => {
    const q = price({ autoDiscounts: [
      rule('a', 'amount_off_over', { amountMinor: 1_000 }),
      rule('b', 'percent_off_over', { percentBps: 2_000 }), // 5000
      rule('c', 'buy_x_get_y', { buyQty: 2, getQty: 1 }), // 3 units: the 5000 one is free, ties with b; b has the lower id
    ] });
    expect(q.autoDiscounts.map((d) => d.id)).toEqual(['b']);
    expect(q.discountMinor).toBe(5_000);
    assertInvariants(q);
  });

  it('puts a buy X get Y saving on the cheapest units\' lines', () => {
    const q = price({ autoDiscounts: [rule('c', 'buy_x_get_y', { buyQty: 2, getQty: 1 })] });
    expect(q.lines.map((l) => l.discountMinor)).toEqual([0, 5_000]);
    expect(q.lines[1]).toMatchObject({ taxMinor: 0, lineTotalMinor: 0 });
    expect(q.autoDiscounts).toEqual([{ id: 'c', name: 'Rule c', kind: 'buy_x_get_y', savingMinor: 5_000 }]);
    // Only product p-a counts: 2 units are not a full set of 3, so nothing is free.
    expect(price({ autoDiscounts: [rule('c', 'buy_x_get_y', { buyQty: 2, getQty: 1, productIds: ['p-a'] })] }).discountMinor).toBe(0);
    assertInvariants(q);
  });

  it('gives the prepaid discount only when paying online, and offers it on cash on delivery', () => {
    const rules = [rule('a', 'percent_off_over', { percentBps: 1_000 }), rule('p', 'prepaid', { percentBps: 400 })];
    const online = price({ autoDiscounts: rules, paymentMethod: 'online', address });
    // 2500, then 4% of 22500 = 900.
    expect(online.autoDiscounts.map((d) => [d.id, d.savingMinor])).toEqual([['a', 2_500], ['p', 900]]);
    expect(online).toMatchObject({ autoDiscountMinor: 3_400, discountMinor: 3_400, prepaidSavingMinor: 0, codFeeMinor: 0 });
    const cod = price({ autoDiscounts: rules, paymentMethod: 'cod', address });
    expect(cod.autoDiscounts.map((d) => d.id)).toEqual(['a']);
    expect(cod).toMatchObject({ autoDiscountMinor: 2_500, discountMinor: 2_500, prepaidSavingMinor: 900, codFeeMinor: 4_900 });
    // The default (no method given) is online.
    expect(price({ autoDiscounts: rules }).autoDiscountMinor).toBe(3_400);
    assertInvariants(online);
    assertInvariants(cod);
  });

  it('gives free shipping to online payment whenever cash on delivery gets it', () => {
    // 10% leaves 22500; paying online takes another 4% (21600), which must not lose the free shipping.
    const rules = [rule('a', 'percent_off_over', { percentBps: 1_000 }), rule('p', 'prepaid', { percentBps: 400 }),
      rule('f', 'free_shipping_over', { minSubtotalMinor: 22_500 })];
    const cod = price({ autoDiscounts: rules, paymentMethod: 'cod', address });
    const online = price({ autoDiscounts: rules, paymentMethod: 'online', address });
    expect(cod.shippingMinor).toBe(0);
    expect(online.shippingMinor).toBe(0);
    expect(online.autoDiscounts.map((d) => d.kind)).toEqual(['percent_off_over', 'prepaid', 'free_shipping_over']);
    expect(online.totalMinor).toBeLessThan(cod.totalMinor);
    assertInvariants(online);
  });

  it('makes shipping free once the subtotal after the order-level rule reaches the minimum', () => {
    const percent = rule('a', 'percent_off_over', { percentBps: 1_000 }); // leaves 22500
    const free = price({ autoDiscounts: [percent, rule('f', 'free_shipping_over', { minSubtotalMinor: 22_500, name: 'Free delivery' })], address });
    expect(free.shippingMinor).toBe(0);
    expect(free.shipping).toMatchObject({ rateId: 'r1', feeMinor: 0, taxMinor: 0 });
    expect(free.autoDiscounts).toEqual([
      { id: 'a', name: 'Rule a', kind: 'percent_off_over', savingMinor: 2_500 },
      { id: 'f', name: 'Free delivery', kind: 'free_shipping_over', savingMinor: 5_000 },
    ]);
    // The waived fee is not part of the merchandise discount.
    expect(free).toMatchObject({ autoDiscountMinor: 2_500, discountMinor: 2_500 });
    assertInvariants(free);

    const paid = price({ autoDiscounts: [percent, rule('f', 'free_shipping_over', { minSubtotalMinor: 22_501 })], address });
    expect(paid.shippingMinor).toBe(5_000);
    expect(paid.shipping?.taxMinor).toBe(900);
    expect(paid.autoDiscounts.map((d) => d.id)).toEqual(['a']);
    // Without an address there is no shipping line to waive yet.
    expect(price({ autoDiscounts: [rule('f', 'free_shipping_over')] }).autoDiscounts).toEqual([]);
  });

  it('still refuses an address no rate serves, even with free shipping', () => {
    expect(priceCart({
      lines: CART, variants: VARIANTS, settings: settings(), shippingRates: [rate({ country: 'US' })], coupon: null, address, now: NOW,
      autoDiscounts: [rule('f', 'free_shipping_over')],
    })).toEqual({ ok: false, code: 'shipping_unavailable' });
  });

  it('never lets discounts take a line below zero or the total below shipping and fees', () => {
    for (const pricesIncludeTax of [true, false]) {
      const q = price({
        settings: settings({ pricesIncludeTax }), paymentMethod: 'cod', address, coupon: coupon({ kind: 'fixed', value: 999_999 }),
        autoDiscounts: [rule('a', 'amount_off_over', { amountMinor: 999_999 }), rule('p', 'prepaid', { amountMinor: 999_999 })],
      });
      expect(q.discountMinor).toBe(25_000);
      expect(q.lines.map((l) => l.discountMinor)).toEqual([20_000, 5_000]);
      expect(q.lines.every((l) => l.taxMinor === 0 && l.lineTotalMinor === 0)).toBe(true);
      // Only shipping and the COD fee (and their tax when prices exclude it) are left to pay.
      expect(q.totalMinor).toBe(5_000 + 4_900 + (pricesIncludeTax ? 0 : q.taxMinor));
      assertInvariants(q);
    }
  });

  it('ignores switched-off and out-of-date rules', () => {
    const q = price({ autoDiscounts: [
      rule('a', 'percent_off_over', { percentBps: 5_000, active: false }),
      rule('b', 'percent_off_over', { percentBps: 5_000, endsAt: NOW }),
      rule('c', 'prepaid', { percentBps: 5_000, startsAt: new Date('2026-12-01T00:00:00Z') }),
    ] });
    expect(q).toMatchObject({ discountMinor: 0, autoDiscountMinor: 0, autoDiscounts: [] });
  });

  it('keeps every invariant across mixed carts, rules, coupons and both tax modes', () => {
    let seed = 11;
    const next = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % n;
    for (let round = 0; round < 200; round++) {
      const variants = Array.from({ length: 1 + next(5) }, (_, i) => variant(`v${i}`, 1 + next(90_000), { taxRateBps: [null, 0, 500, 1_200][next(4)] }));
      const result = priceCart({
        lines: variants.map((v) => ({ variantId: v.id, qty: 1 + next(6) })), variants,
        settings: settings({ pricesIncludeTax: next(2) === 0 }), shippingRates: [rate()], address: next(2) ? address : null, now: NOW,
        paymentMethod: next(2) ? 'cod' : 'online', coupon: next(2) ? coupon({ value: 1 + next(10_000) }) : null,
        autoDiscounts: [
          rule('a', 'amount_off_over', { amountMinor: 1 + next(100_000), minSubtotalMinor: next(50_000) }),
          rule('b', 'percent_off_over', { percentBps: 1 + next(10_000) }),
          rule('c', 'buy_x_get_y', { buyQty: 1 + next(3), getQty: 1 + next(2) }),
          rule('p', 'prepaid', { percentBps: 1 + next(10_000) }),
          rule('f', 'free_shipping_over', { minSubtotalMinor: next(100_000) }),
        ],
      });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      assertInvariants(result.quote);
    }
  });
});
