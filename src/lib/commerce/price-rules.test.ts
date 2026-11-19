import { describe, expect, it } from 'vitest';
import type { PricingAutoDiscount } from './auto-discounts';
import {
  earnReversal, giftsFor, lineRuleOutcome, pointsEarned, tenderFor, tierUnitPrice, type PricingGiftRule, type PricingLineRule, type PricingPriceTier,
} from './price-rules';
import { priceCart, type PriceCartInput, type PricingCoupon, type PricingVariant, type Quote } from './pricing';

// Store plan Phase 8 price rules: the stacking order (price list -> line rules -> automatic discounts -> coupon ->
// gift -> points -> store credit), the combine / does-not-combine matrix, and the ledger arithmetic.
const NOW = new Date('2026-12-01T10:00:00Z');
const A = 'a0000000-0000-4000-8000-000000000001', B = 'b0000000-0000-4000-8000-000000000002', G = 'c0000000-0000-4000-8000-000000000003';
const PA = 'pa', PB = 'pb', PG = 'pg';

const variant = (id: string, productId: string, priceMinor: number, extra: Partial<PricingVariant> = {}): PricingVariant => ({
  id, productId, productName: productId.toUpperCase(), sku: `SKU-${productId}`, optionValues: {}, priceMinor, taxRateBps: null, hsnCode: null,
  trackInventory: true, sellable: true, ...extra,
});
const VARIANTS = [variant(A, PA, 10_000, { categoryId: 'c1' }), variant(B, PB, 5_000, { categoryId: 'c2' }), variant(G, PG, 2_000, { available: 3 })];

const rule = (id: string, extra: Partial<PricingLineRule>): PricingLineRule => ({
  id, name: `rule ${id}`, productId: null, categoryIds: null, kind: 'percent', value: 1000, combinable: true, active: true, startsAt: null, endsAt: null, ...extra,
});
const gift = (id: string, extra: Partial<PricingGiftRule>): PricingGiftRule => ({
  id, name: `gift ${id}`, minSubtotalMinor: null, triggerProductId: null, giftVariantId: G, active: true, startsAt: null, endsAt: null, ...extra,
});
const auto = (id: string, extra: Partial<PricingAutoDiscount>): PricingAutoDiscount => ({
  id, name: `auto ${id}`, kind: 'percent_off_over', minSubtotalMinor: 0, amountMinor: null, percentBps: null, buyQty: null, getQty: null, productIds: [],
  active: true, startsAt: null, endsAt: null, ...extra,
});
const COUPON20: PricingCoupon = { code: 'SAVE20', kind: 'percent', value: 2000, minSubtotalMinor: 0, maxDiscountMinor: null, startsAt: null, endsAt: null, active: true };

function price(extra: Partial<PriceCartInput> = {}): Quote {
  const result = priceCart({
    lines: [{ variantId: A, qty: 2 }, { variantId: B, qty: 1 }], variants: VARIANTS,
    settings: { currency: 'INR', pricesIncludeTax: false, defaultTaxRateBps: 500 }, shippingRates: [], coupon: null, address: null, now: NOW, ...extra,
  });
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.quote;
}

/** What must hold for every quote, whatever applied. */
function assertConsistent(q: Quote): void {
  expect(q.lines.reduce((n, l) => n + l.discountMinor, 0)).toBe(q.discountMinor);
  expect(q.lines.reduce((n, l) => n + l.grossMinor, 0)).toBe(q.subtotalMinor);
  for (const l of q.lines) {
    expect(l.discountMinor).toBeGreaterThanOrEqual(0);
    expect(l.discountMinor).toBeLessThanOrEqual(l.grossMinor);
    expect(l.grossMinor).toBe(l.unitPriceMinor * l.qty);
    expect(l.unitPriceMinor).toBeLessThanOrEqual(l.catalogPriceMinor);
  }
  expect(q.totalMinor).toBe(q.subtotalMinor - q.discountMinor + q.shippingMinor + q.codFeeMinor + (q.taxInclusive ? 0 : q.taxMinor));
  expect(q.payableMinor).toBe(q.totalMinor - q.pointsValueMinor - q.storeCreditMinor);
  expect(q.payableMinor).toBeGreaterThanOrEqual(0);
  expect(q.autoDiscountMinor).toBeLessThanOrEqual(q.discountMinor);
  expect(q.ruleDiscountMinor).toBeLessThanOrEqual(q.autoDiscountMinor);
}

describe('price lists', () => {
  const tiers: PricingPriceTier[] = [
    { variantId: A, minQty: 1, priceMinor: 9_000 }, { variantId: A, minQty: 10, priceMinor: 8_000 }, { variantId: B, minQty: 5, priceMinor: 4_000 },
  ];

  it('takes the lowest tier the quantity reaches and never raises a price', () => {
    expect(tierUnitPrice(tiers, A, 1, 10_000)).toBe(9_000);
    expect(tierUnitPrice(tiers, A, 9, 10_000)).toBe(9_000);
    expect(tierUnitPrice(tiers, A, 10, 10_000)).toBe(8_000);
    expect(tierUnitPrice(tiers, B, 4, 5_000)).toBe(5_000);
    expect(tierUnitPrice(tiers, B, 5, 5_000)).toBe(4_000);
    expect(tierUnitPrice([{ variantId: A, minQty: 1, priceMinor: 12_000 }], A, 1, 10_000)).toBe(10_000);
    // Two lists the buyer is in: the better price.
    expect(tierUnitPrice([...tiers, { variantId: A, minQty: 1, priceMinor: 8_500 }], A, 2, 10_000)).toBe(8_500);
    expect(tierUnitPrice([], A, 2, 10_000)).toBe(10_000);
  });

  it('prices the line at the wholesale unit and keeps the catalogue price for display', () => {
    const q = price({ priceTiers: tiers, lines: [{ variantId: A, qty: 10 }, { variantId: B, qty: 1 }] });
    expect(q.lines[0]).toMatchObject({ unitPriceMinor: 8_000, catalogPriceMinor: 10_000, grossMinor: 80_000, discountMinor: 0 });
    expect(q.lines[1]).toMatchObject({ unitPriceMinor: 5_000, catalogPriceMinor: 5_000 });
    expect(q).toMatchObject({ subtotalMinor: 85_000, discountMinor: 0, taxMinor: 4_250, totalMinor: 89_250 });
    assertConsistent(q);
  });
});

describe('discount rules on a line', () => {
  const line = { productId: PA, categoryId: 'c1', unitMinor: 10_000, qty: 2, grossMinor: 20_000 };

  it('matches by product, by category, or everything', () => {
    const rules = [
      rule('1', { productId: PA, value: 1000 }), rule('2', { productId: PB, value: 9000 }),
      rule('3', { categoryIds: ['c1', 'c1-child'], value: 500 }), rule('4', { categoryIds: ['c2'], value: 9000 }), rule('5', { value: 100 }),
    ];
    const out = lineRuleOutcome(rules, line, NOW);
    expect(out.combinable).toEqual([
      { id: '1', name: 'rule 1', savingMinor: 2_000 }, { id: '3', name: 'rule 3', savingMinor: 1_000 }, { id: '5', name: 'rule 5', savingMinor: 200 },
    ]);
    expect(out.combinableMinor).toBe(3_200);
    expect(out.exclusive).toBeNull();
  });

  it('takes a fixed amount off each unit, never more than the unit', () => {
    expect(lineRuleOutcome([rule('1', { kind: 'fixed', value: 1_500 })], line, NOW).combinableMinor).toBe(3_000);
    expect(lineRuleOutcome([rule('1', { kind: 'fixed', value: 99_999 })], line, NOW).combinableMinor).toBe(20_000);
  });

  it('adds combinable rules up on the same line amount, never past it', () => {
    const out = lineRuleOutcome([rule('1', { value: 6000 }), rule('2', { value: 6000 })], line, NOW);
    expect(out.combinable.map((r) => r.savingMinor)).toEqual([12_000, 8_000]);
    expect(out.combinableMinor).toBe(20_000);
  });

  it('keeps the single best rule that does not combine (a tie to the lowest id)', () => {
    const out = lineRuleOutcome([
      rule('3', { combinable: false, value: 2500 }), rule('1', { combinable: false, value: 1000 }), rule('2', { combinable: false, value: 2500 }),
      rule('4', { value: 500 }),
    ], line, NOW);
    expect(out.exclusive).toEqual({ id: '2', name: 'rule 2', savingMinor: 5_000 });
    expect(out.combinableMinor).toBe(1_000);
  });

  it('skips rules that are off or outside their dates, and rounds a percent half up', () => {
    const rules = [
      rule('1', { active: false }), rule('2', { startsAt: new Date('2026-12-02T00:00:00Z') }), rule('3', { endsAt: NOW }),
      rule('4', { value: 333, endsAt: new Date('2026-12-02T00:00:00Z') }),
    ];
    // 3.33% of 14 985 = 498.9...; of 15 = 0.4995 -> 0 (a rule that saves nothing is not listed).
    expect(lineRuleOutcome(rules, { ...line, unitMinor: 14_985, qty: 1, grossMinor: 14_985 }, NOW).combinable).toEqual([{ id: '4', name: 'rule 4', savingMinor: 499 }]);
    expect(lineRuleOutcome(rules, { ...line, unitMinor: 15, qty: 1, grossMinor: 15 }, NOW).combinable).toEqual([]);
  });
});

describe('the stacking order in priceCart', () => {
  it('applies price list, then line rules, then the automatic discount, then the coupon', () => {
    const q = price({
      priceTiers: [{ variantId: A, minQty: 2, priceMinor: 9_000 }],
      lineRules: [rule('r1', { productId: PA, value: 1000 })],
      autoDiscounts: [auto('a1', { percentBps: 1000 })],
      coupon: COUPON20,
    });
    // A: 2 × 9000 = 18000, rule 10% = 1800 -> 16200. B: 5000. Open merchandise 21200.
    // Automatic 10% of 21200 = 2120 (A 1620, B 500) -> 19080. Coupon 20% of 19080 = 3816 (A 2916, B 900).
    expect(q.subtotalMinor).toBe(23_000);
    expect(q.ruleDiscountMinor).toBe(1_800);
    expect(q.autoDiscountMinor).toBe(3_920);
    expect(q.discountMinor).toBe(7_736);
    expect(q.autoDiscounts).toEqual([
      { id: 'r1', name: 'rule r1', kind: 'price_rule', savingMinor: 1_800 }, { id: 'a1', name: 'auto a1', kind: 'percent_off_over', savingMinor: 2_120 },
    ]);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([1_800 + 1_620 + 2_916, 500 + 900]);
    // Tax 5% on each taxable line: 11664 -> 583, 3600 -> 180.
    expect(q.taxMinor).toBe(763);
    expect(q.totalMinor).toBe(23_000 - 7_736 + 763);
    assertConsistent(q);
  });

  it('reads automatic discount minimums and the coupon minimum after the line rules', () => {
    const rules = [rule('r1', { value: 5000 })]; // half off everything: 25000 -> 12500
    const q = price({ lineRules: rules, autoDiscounts: [auto('a1', { percentBps: 1000, minSubtotalMinor: 20_000 })] });
    expect(q.autoDiscounts.map((d) => d.id)).toEqual(['r1']);
    const refused = priceCart({
      lines: [{ variantId: A, qty: 2 }, { variantId: B, qty: 1 }], variants: VARIANTS, settings: { currency: 'INR', pricesIncludeTax: false, defaultTaxRateBps: 500 },
      shippingRates: [], address: null, now: NOW, lineRules: rules, coupon: { ...COUPON20, minSubtotalMinor: 20_000 },
    });
    expect(refused).toEqual({ ok: false, code: 'coupon_min_subtotal' });
  });

  it('uses a rule that does not combine when the cart is cheaper that way, alone on its line', () => {
    const q = price({
      lineRules: [rule('x', { productId: PA, combinable: false, value: 4000 }), rule('c', { productId: PA, value: 1000 })],
      autoDiscounts: [auto('a1', { percentBps: 1000 })],
      coupon: COUPON20,
    });
    // With x: A 20000 − 8000 = 12000, closed. B 5000: automatic 500, coupon 20% of 4500 = 900. Total discount 9400.
    // Without x: A 20000 − 2000 = 18000; open 23000; automatic 2300; coupon 20% of 20700 = 4140. Total discount 8440.
    expect(q.discountMinor).toBe(9_400);
    expect(q.lines.map((l) => l.discountMinor)).toEqual([8_000, 1_400]);
    expect(q.autoDiscounts).toEqual([
      { id: 'x', name: 'rule x', kind: 'price_rule', savingMinor: 8_000 }, { id: 'a1', name: 'auto a1', kind: 'percent_off_over', savingMinor: 500 },
    ]);
    assertConsistent(q);
  });

  it('leaves a rule that does not combine out when the combinable way is cheaper for the buyer', () => {
    const q = price({
      lineRules: [rule('x', { productId: PA, combinable: false, value: 1200 }), rule('c', { productId: PA, value: 1000 })],
      autoDiscounts: [auto('a1', { percentBps: 1000 })],
      coupon: COUPON20,
    });
    // With x: A 20000 − 2400, closed; B 500 + 900 -> 3800. Without x: 8440 (above). The buyer gets 8440.
    expect(q.discountMinor).toBe(8_440);
    expect(q.autoDiscounts.map((d) => d.id)).toEqual(['c', 'a1']);
    assertConsistent(q);
  });

  it('keeps the combinable way on a tie, and ignores a weaker rule that does not combine on its own line', () => {
    const tie = price({ lineRules: [rule('x', { productId: PA, combinable: false, value: 1000 }), rule('c', { productId: PA, value: 1000 })] });
    expect(tie.autoDiscounts.map((d) => d.id)).toEqual(['c']);
    const weaker = price({ lineRules: [rule('x', { productId: PA, combinable: false, value: 500 }), rule('c', { productId: PA, value: 1000 })] });
    expect(weaker.autoDiscounts.map((d) => d.id)).toEqual(['c']);
    expect(weaker.discountMinor).toBe(2_000);
  });

  it('falls back to the combinable way when the other way would refuse the coupon', () => {
    // With x every line is closed, so the coupon (minimum 1) has nothing to work on: that pricing is refused and dropped.
    const q = price({ lineRules: [rule('x', { combinable: false, value: 1500 })], coupon: { ...COUPON20, minSubtotalMinor: 1 } });
    expect(q.couponCode).toBe('SAVE20');
    expect(q.discountMinor).toBe(5_000);
    assertConsistent(q);
  });

  it('holds its sums for every mix of rules, tax mode, payment and tender', () => {
    const tiers = [undefined, [{ variantId: A, minQty: 2, priceMinor: 9_999 }]];
    const rules = [undefined, [rule('c', { value: 333 })], [rule('c', { value: 333 }), rule('x', { productId: PB, combinable: false, kind: 'fixed' as const, value: 1_234 })]];
    const autos = [undefined, [auto('a1', { percentBps: 777 }), auto('p', { kind: 'prepaid' as const, percentBps: 150 })]];
    const coupons = [null, COUPON20, { ...COUPON20, kind: 'fixed' as const, value: 1_111 }];
    const gifts = [undefined, [gift('g', { minSubtotalMinor: 10_000 })]];
    const tenders = [undefined, { storeCreditMinor: 7_777, points: { balance: 500, valueMinor: 7, maxBps: 2_500 } }, { storeCreditMinor: 10_000_000, points: null }];
    let count = 0;
    for (const priceTiers of tiers) for (const lineRules of rules) for (const autoDiscounts of autos) for (const coupon of coupons)
      for (const giftRules of gifts) for (const tender of tenders) for (const pricesIncludeTax of [false, true]) for (const paymentMethod of ['online', 'cod'] as const) {
        const q = price({
          priceTiers, lineRules, autoDiscounts, coupon, giftRules, tender, paymentMethod,
          settings: { currency: 'INR', pricesIncludeTax, defaultTaxRateBps: 1_800, codEnabled: true, codFeeMinor: 4_900 },
          address: { country: 'IN', postalCode: '560001' },
          shippingRates: [{ id: 's', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 6_000, taxRateBps: null, position: 0 }],
        });
        assertConsistent(q);
        // The same inputs always give the same quote.
        expect(price({
          priceTiers, lineRules, autoDiscounts, coupon, giftRules, tender, paymentMethod,
          settings: { currency: 'INR', pricesIncludeTax, defaultTaxRateBps: 1_800, codEnabled: true, codFeeMinor: 4_900 },
          address: { country: 'IN', postalCode: '560001' },
          shippingRates: [{ id: 's', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 6_000, taxRateBps: null, position: 0 }],
        })).toEqual(q);
        count += 1;
      }
    expect(count).toBe(2 * 3 * 2 * 3 * 2 * 3 * 2 * 2);
  });
});

describe('free gift with purchase', () => {
  it('adds the gift at 0 when the spend is reached after discounts, and drops it when it is not', () => {
    const giftRules = [gift('g1', { minSubtotalMinor: 25_000 })];
    const q = price({ giftRules });
    expect(q.lines).toHaveLength(3);
    expect(q.lines[2]).toMatchObject({ variantId: G, qty: 1, unitPriceMinor: 0, grossMinor: 0, discountMinor: 0, taxMinor: 0, lineTotalMinor: 0, gift: true, giftName: 'gift g1', catalogPriceMinor: 2_000 });
    expect(q.totalMinor).toBe(price().totalMinor);
    assertConsistent(q);
    // A discount takes the merchandise under the threshold: no gift.
    expect(price({ giftRules, lineRules: [rule('r', { value: 100 })] }).lines).toHaveLength(2);
    expect(price({ giftRules, lines: [{ variantId: A, qty: 1 }] }).lines).toHaveLength(1);
  });

  it('adds the gift for buying a product, only while that product is in the cart', () => {
    const giftRules = [gift('g1', { triggerProductId: PB })];
    expect(price({ giftRules }).lines.filter((l) => l.gift)).toHaveLength(1);
    expect(price({ giftRules, lines: [{ variantId: A, qty: 2 }] }).lines.filter((l) => l.gift)).toHaveLength(0);
  });

  it('skips a gift that is not on sale or has no unit left, also counting units of it already in the cart', () => {
    const giftRules = [gift('g1', { minSubtotalMinor: 1 })];
    const withGift = (g: Partial<PricingVariant>, lines = [{ variantId: A, qty: 1 }]) =>
      price({ giftRules, lines, variants: [VARIANTS[0], VARIANTS[1], variant(G, PG, 2_000, g)] }).lines.filter((l) => l.gift).length;
    expect(withGift({ available: 1 })).toBe(1);
    expect(withGift({ available: 0 })).toBe(0);
    expect(withGift({ sellable: false })).toBe(0);
    expect(withGift({ available: null })).toBe(1);
    // Two paid units of the gift variant are in the cart and only two exist: no third one to give.
    expect(withGift({ available: 2 }, [{ variantId: A, qty: 1 }, { variantId: G, qty: 2 }])).toBe(0);
    expect(withGift({ available: 3 }, [{ variantId: A, qty: 1 }, { variantId: G, qty: 2 }])).toBe(1);
    // The rule's gift variant was not loaded: nothing is added and nothing throws.
    expect(price({ giftRules, variants: [VARIANTS[0], VARIANTS[1]] }).lines).toHaveLength(2);
  });

  it('gives one gift per variant, at most five, in rule id order', () => {
    const picked = giftsFor([gift('b', { minSubtotalMinor: 1 }), gift('a', { minSubtotalMinor: 1 }), gift('c', { minSubtotalMinor: 99 })], 50, new Set(), NOW);
    expect(picked.map((g) => g.id)).toEqual(['a']);
    const many = Array.from({ length: 8 }, (_, i) => gift(`g${i}`, { minSubtotalMinor: 1, giftVariantId: `v${i}` }));
    expect(giftsFor(many, 50, new Set(), NOW)).toHaveLength(5);
  });
});

describe('points and store credit pay part of the total', () => {
  it('spends points first up to the cap, then store credit, and never changes the total or the tax', () => {
    const plain = price();
    expect(plain).toMatchObject({ totalMinor: 26_250, pointsRedeemed: 0, pointsValueMinor: 0, storeCreditMinor: 0, payableMinor: 26_250 });
    // Cap 20% of 26250 = 5250; a point pays 100: 52 points = 5200. Credit 3000 on the rest.
    const q = price({ tender: { storeCreditMinor: 3_000, points: { balance: 400, valueMinor: 100, maxBps: 2_000 } } });
    expect(q).toMatchObject({ totalMinor: 26_250, taxMinor: plain.taxMinor, pointsRedeemed: 52, pointsValueMinor: 5_200, storeCreditMinor: 3_000, payableMinor: 18_050 });
    assertConsistent(q);
  });

  it('never spends more than the balance or more than the total', () => {
    expect(tenderFor(26_250, { storeCreditMinor: 0, points: { balance: 10, valueMinor: 100, maxBps: 10_000 } })).toEqual({ pointsRedeemed: 10, pointsValueMinor: 1_000, storeCreditMinor: 0, payableMinor: 25_250 });
    expect(tenderFor(26_250, { storeCreditMinor: 99_999, points: null })).toEqual({ pointsRedeemed: 0, pointsValueMinor: 0, storeCreditMinor: 26_250, payableMinor: 0 });
    expect(tenderFor(26_250, { storeCreditMinor: 99_999, points: { balance: 9_999, valueMinor: 100, maxBps: 10_000 } })).toEqual({ pointsRedeemed: 262, pointsValueMinor: 26_200, storeCreditMinor: 50, payableMinor: 0 });
    // A point worth more than the cap allows buys nothing.
    expect(tenderFor(1_000, { storeCreditMinor: 0, points: { balance: 5, valueMinor: 300, maxBps: 2_000 } }).pointsRedeemed).toBe(0);
    expect(tenderFor(0, { storeCreditMinor: 500, points: { balance: 5, valueMinor: 1, maxBps: 10_000 } })).toEqual({ pointsRedeemed: 0, pointsValueMinor: 0, storeCreditMinor: 0, payableMinor: 0 });
    expect(tenderFor(500, null)).toEqual({ pointsRedeemed: 0, pointsValueMinor: 0, storeCreditMinor: 0, payableMinor: 500 });
    // Malformed balances are ignored, never trusted.
    expect(tenderFor(500, { storeCreditMinor: -5, points: { balance: 1.5, valueMinor: 100, maxBps: 2_000 } }).payableMinor).toBe(500);
  });
});

describe('loyalty ledger arithmetic', () => {
  const earn = { earnPoints: 1, earnSpendMinor: 10_000 };

  it('earns whole points, rounded down', () => {
    expect(pointsEarned(26_250, earn)).toBe(2);
    expect(pointsEarned(9_999, earn)).toBe(0);
    expect(pointsEarned(10_000, earn)).toBe(1);
    expect(pointsEarned(26_250, { earnPoints: 5, earnSpendMinor: 100 })).toBe(1_312);
    expect(pointsEarned(0, earn)).toBe(0);
    expect(pointsEarned(-5, earn)).toBe(0);
    expect(pointsEarned(Number.MAX_SAFE_INTEGER, { earnPoints: 1000, earnSpendMinor: 1 })).toBe(100_000_000);
  });

  it('takes points back in the share refunded, all of them on a full refund, never twice', () => {
    expect(earnReversal(100, 0, 2_500, 10_000)).toBe(25);
    expect(earnReversal(100, 25, 2_500, 10_000)).toBe(0);
    expect(earnReversal(100, 25, 5_000, 10_000)).toBe(25);
    expect(earnReversal(100, 50, 10_000, 10_000)).toBe(50);
    expect(earnReversal(100, 50, 12_000, 10_000)).toBe(50);
    // 3 points on 10000, 3333 refunded: 0.9999 of a point rounds down, the buyer keeps it until more is refunded.
    expect(earnReversal(3, 0, 3_333, 10_000)).toBe(0);
    expect(earnReversal(3, 0, 3_334, 10_000)).toBe(1);
    expect(earnReversal(0, 0, 5_000, 10_000)).toBe(0);
    expect(earnReversal(100, 0, 0, 10_000)).toBe(0);
    expect(earnReversal(100, 100, 10_000, 10_000)).toBe(0);
    // Partial refunds always add up to the full reversal.
    let reversed = 0;
    for (const refunded of [1_111, 3_333, 7_000, 9_999, 10_000]) reversed += earnReversal(97, reversed, refunded, 10_000);
    expect(reversed).toBe(97);
  });
});
