import { describe, expect, it } from 'vitest';
import { applyAutoDiscounts, autoDiscountLive, buyXGetYShares, parseDiscountDetails, type AutoDiscountLine, type PricingAutoDiscount } from './auto-discounts';

const NOW = new Date('2026-11-28T10:00:00Z');
const rule = (id: string, kind: PricingAutoDiscount['kind'], extra: Partial<PricingAutoDiscount> = {}): PricingAutoDiscount => ({
  id, name: `Rule ${id}`, kind, minSubtotalMinor: 0, amountMinor: null, percentBps: null, buyQty: null, getQty: null, productIds: [],
  active: true, startsAt: null, endsAt: null, ...extra,
});
const line = (productId: string, unitMinor: number, qty: number): AutoDiscountLine => ({ productId, unitMinor, qty, grossMinor: unitMinor * qty });
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const run = (rules: PricingAutoDiscount[], lines: AutoDiscountLine[], method: 'online' | 'cod' = 'online') => applyAutoDiscounts(rules, lines, method, NOW);

describe('autoDiscountLive', () => {
  it('counts only active rules inside their dates (start inclusive, end exclusive)', () => {
    expect(autoDiscountLive(rule('a', 'prepaid'), NOW)).toBe(true);
    expect(autoDiscountLive(rule('a', 'prepaid', { active: false }), NOW)).toBe(false);
    expect(autoDiscountLive(rule('a', 'prepaid', { startsAt: NOW }), NOW)).toBe(true);
    expect(autoDiscountLive(rule('a', 'prepaid', { startsAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(false);
    expect(autoDiscountLive(rule('a', 'prepaid', { endsAt: NOW }), NOW)).toBe(false);
    expect(autoDiscountLive(rule('a', 'prepaid', { endsAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(true);
  });
});

describe('applyAutoDiscounts: the best order-level rule', () => {
  const cart = [line('p1', 60_000, 1), line('p2', 40_000, 1)]; // subtotal 100000

  it('applies only the rule that saves the most', () => {
    const out = run([
      rule('a', 'amount_off_over', { amountMinor: 5_000 }),
      rule('b', 'percent_off_over', { percentBps: 1_000 }), // 10000
      rule('c', 'buy_x_get_y', { buyQty: 5, getQty: 1 }), // not enough units: saves nothing
    ], cart);
    expect(out.applied).toEqual([{ id: 'b', name: 'Rule b', kind: 'percent_off_over', savingMinor: 10_000 }]);
    expect(out.discountMinor).toBe(10_000);
    expect(out.lineDiscounts).toEqual([6_000, 4_000]);
  });

  it('breaks a tie by the lowest id, whatever order the rules arrive in', () => {
    const amount = rule('b', 'amount_off_over', { amountMinor: 10_000 });
    const percent = rule('a', 'percent_off_over', { percentBps: 1_000 });
    expect(run([amount, percent], cart).applied[0].id).toBe('a');
    expect(run([percent, amount], cart).applied[0].id).toBe('a');
    expect(run([{ ...amount, id: 'a' }, { ...percent, id: 'b' }], cart).applied[0].kind).toBe('amount_off_over');
  });

  it('ignores switched-off, not-yet-started, ended and below-minimum rules', () => {
    const out = run([
      rule('a', 'percent_off_over', { percentBps: 5_000, active: false }),
      rule('b', 'percent_off_over', { percentBps: 5_000, startsAt: new Date('2026-12-01T00:00:00Z') }),
      rule('c', 'percent_off_over', { percentBps: 5_000, endsAt: NOW }),
      rule('d', 'percent_off_over', { percentBps: 5_000, minSubtotalMinor: 100_001 }),
      rule('e', 'amount_off_over', { amountMinor: 100, minSubtotalMinor: 100_000 }),
    ], cart);
    expect(out.applied.map((a) => a.id)).toEqual(['e']);
    expect(out.discountMinor).toBe(100);
  });

  it('never takes a line below zero: an amount larger than the cart stops at the subtotal', () => {
    const small = [line('p1', 1_000, 1), line('p2', 500, 1)];
    const out = run([rule('a', 'amount_off_over', { amountMinor: 999_999 }), rule('z', 'prepaid', { percentBps: 1_000 })], small);
    expect(out.lineDiscounts).toEqual([1_000, 500]);
    expect(out.discountMinor).toBe(1_500);
    // Nothing is left for the prepaid rule, so it is not listed.
    expect(out.applied.map((a) => a.id)).toEqual(['a']);
  });

  it('gives no discount with no rules or an empty-value cart', () => {
    expect(run([], cart)).toEqual({ applied: [], lineDiscounts: [0, 0], discountMinor: 0, freeShipping: null, prepaidOffer: null });
    expect(run([rule('a', 'percent_off_over', { percentBps: 1_000 })], [line('p1', 0, 2)]).discountMinor).toBe(0);
  });
});

describe('applyAutoDiscounts: prepaid', () => {
  const cart = [line('p1', 60_000, 1), line('p2', 40_000, 1)];
  const rules = [rule('a', 'percent_off_over', { percentBps: 1_000 }), rule('p', 'prepaid', { percentBps: 500 })];

  it('stacks on the best rule when paying online, on the reduced subtotal', () => {
    const out = run(rules, cart, 'online');
    // 10% of 100000 = 10000, then 5% of 90000 = 4500
    expect(out.applied.map((a) => [a.id, a.savingMinor])).toEqual([['a', 10_000], ['p', 4_500]]);
    expect(out.discountMinor).toBe(14_500);
    expect(out.lineDiscounts).toEqual([8_700, 5_800]);
    expect(out.prepaidOffer).toBeNull();
  });

  it('does not apply on cash on delivery, and says what paying online would save', () => {
    const out = run(rules, cart, 'cod');
    expect(out.applied.map((a) => a.id)).toEqual(['a']);
    expect(out.discountMinor).toBe(10_000);
    expect(out.prepaidOffer).toEqual({ id: 'p', name: 'Rule p', kind: 'prepaid', savingMinor: 4_500 });
  });

  it('reads its minimum against the reduced subtotal and caps an amount at what is left', () => {
    expect(run([rules[0], rule('p', 'prepaid', { amountMinor: 2_000, minSubtotalMinor: 90_001 })], cart).applied.map((a) => a.id)).toEqual(['a']);
    expect(run([rules[0], rule('p', 'prepaid', { amountMinor: 2_000, minSubtotalMinor: 90_000 })], cart).discountMinor).toBe(12_000);
    expect(run([rule('p', 'prepaid', { amountMinor: 500_000 })], cart).lineDiscounts).toEqual([60_000, 40_000]);
  });

  it('with several prepaid rules applies only the best one', () => {
    const out = run([rule('p1', 'prepaid', { amountMinor: 1_000 }), rule('p2', 'prepaid', { percentBps: 200 })], cart);
    expect(out.applied).toEqual([{ id: 'p2', name: 'Rule p2', kind: 'prepaid', savingMinor: 2_000 }]);
  });
});

describe('applyAutoDiscounts: buy X get Y', () => {
  const cart = [line('pa', 500, 2), line('pb', 300, 1), line('pc', 200, 3)]; // 6 units

  it('frees the cheapest units and puts the saving on their lines', () => {
    const bxgy = rule('x', 'buy_x_get_y', { buyQty: 2, getQty: 1 });
    // 6 units / (2+1) = 2 free units: the two cheapest are both from pc.
    expect(buyXGetYShares(bxgy, cart)).toEqual([0, 0, 400]);
    const out = run([bxgy], cart);
    expect(out.applied).toEqual([{ id: 'x', name: 'Rule x', kind: 'buy_x_get_y', savingMinor: 400 }]);
    expect(out.lineDiscounts).toEqual([0, 0, 400]);
  });

  it('spreads free units over lines from the cheapest up, and gives nothing for a partial set', () => {
    // buy 1 get 1 over 6 units: 3 free: pc, pc, pc (200 each).
    expect(buyXGetYShares(rule('x', 'buy_x_get_y', { buyQty: 1, getQty: 1 }), cart)).toEqual([0, 0, 600]);
    // buy 1 get 2: floor(6 / 3) * 2 = 4 free: pc ×3, then pb ×1.
    expect(buyXGetYShares(rule('x', 'buy_x_get_y', { buyQty: 1, getQty: 2 }), cart)).toEqual([0, 300, 600]);
    // 5 units of one product, buy 1 get 1: 2 free, the fifth unit earns nothing.
    expect(buyXGetYShares(rule('x', 'buy_x_get_y', { buyQty: 1, getQty: 1 }), [line('pa', 100, 5)])).toEqual([200]);
    expect(buyXGetYShares(rule('x', 'buy_x_get_y', { buyQty: 3, getQty: 4 }), cart)).toEqual([0, 0, 0]);
  });

  it('counts only the rule\'s products when it names some', () => {
    const only = rule('x', 'buy_x_get_y', { buyQty: 2, getQty: 1, productIds: ['pa', 'pb'] });
    // 3 eligible units: 1 free, the cheapest eligible one (pb), never pc.
    expect(buyXGetYShares(only, cart)).toEqual([0, 300, 0]);
    expect(buyXGetYShares({ ...only, productIds: ['nope'] }, cart)).toEqual([0, 0, 0]);
  });

  it('breaks equal prices by the earlier line', () => {
    const same = [line('pa', 100, 1), line('pb', 100, 1)];
    expect(buyXGetYShares(rule('x', 'buy_x_get_y', { buyQty: 1, getQty: 1 }), same)).toEqual([100, 0]);
  });

  it('competes with the other order-level rules by saving', () => {
    const bxgy = rule('x', 'buy_x_get_y', { buyQty: 2, getQty: 1 }); // 400
    expect(run([bxgy, rule('a', 'amount_off_over', { amountMinor: 399 })], cart).applied[0].id).toBe('x');
    expect(run([bxgy, rule('a', 'amount_off_over', { amountMinor: 401 })], cart).applied[0].id).toBe('a');
  });
});

describe('applyAutoDiscounts: free shipping', () => {
  const cart = [line('p1', 100_000, 1)];
  const percent = rule('a', 'percent_off_over', { percentBps: 1_000 }); // leaves 90000
  const prepaid = rule('p', 'prepaid', { percentBps: 500 }); // leaves 85500 online

  it('reads the subtotal after the order-level rule', () => {
    expect(run([percent, rule('f', 'free_shipping_over', { minSubtotalMinor: 90_001 })], cart).freeShipping).toBeNull();
    expect(run([percent, rule('f', 'free_shipping_over', { minSubtotalMinor: 90_000 })], cart).freeShipping).toEqual({ id: 'f', name: 'Rule f' });
    expect(run([rule('f', 'free_shipping_over', { minSubtotalMinor: 100_000 })], cart).freeShipping?.id).toBe('f');
  });

  it('ignores the prepaid discount: when cash on delivery gets free shipping, paying online gets it too', () => {
    // After the 10% rule 90000 is left; online the prepaid rule takes it to 85500, below the minimum.
    const free = rule('f', 'free_shipping_over', { minSubtotalMinor: 90_000 });
    const cod = run([percent, prepaid, free], cart, 'cod');
    const online = run([percent, prepaid, free], cart, 'online');
    expect(cod.freeShipping).toEqual({ id: 'f', name: 'Rule f' });
    expect(online.freeShipping).toEqual(cod.freeShipping);
    expect(online.discountMinor).toBe(14_500);
    // One unit short of the minimum: neither method qualifies.
    const strict = rule('f', 'free_shipping_over', { minSubtotalMinor: 90_001 });
    expect(run([percent, prepaid, strict], cart, 'cod').freeShipping).toBeNull();
    expect(run([percent, prepaid, strict], cart, 'online').freeShipping).toBeNull();
  });

  it('is not a money discount', () => {
    const out = run([rule('f', 'free_shipping_over')], cart);
    expect(out.discountMinor).toBe(0);
    expect(out.applied).toEqual([]);
  });
});

describe('parseDiscountDetails', () => {
  it('keeps well-formed entries and drops everything else', () => {
    expect(parseDiscountDetails([
      { name: 'Ten off', kind: 'percent_off_over', saving_minor: 500, rule_id: 'ignored' },
      { name: 'Bad kind', kind: 'other', saving_minor: 1 },
      { name: 'Negative', kind: 'prepaid', saving_minor: -1 },
      { name: 7, kind: 'prepaid', saving_minor: 1 },
      'text', null,
    ])).toEqual([{ name: 'Ten off', kind: 'percent_off_over', saving_minor: 500 }]);
    expect(parseDiscountDetails(null)).toEqual([]);
    expect(parseDiscountDetails({ name: 'x' })).toEqual([]);
  });
});

describe('applyAutoDiscounts: invariants', () => {
  it('line discounts sum to the discount and never pass the line, across many carts', () => {
    let seed = 7;
    const next = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % n;
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + next(6) }, (_, i) => line(`p${i % 3}`, next(5_000), 1 + next(9)));
      const rules = [
        rule('a', 'amount_off_over', { amountMinor: 1 + next(20_000), minSubtotalMinor: next(10_000) }),
        rule('b', 'percent_off_over', { percentBps: 1 + next(10_000) }),
        rule('c', 'buy_x_get_y', { buyQty: 1 + next(3), getQty: 1 + next(2), productIds: next(2) ? ['p0', 'p1'] : [] }),
        rule('p', 'prepaid', next(2) ? { percentBps: 1 + next(10_000) } : { amountMinor: 1 + next(20_000) }),
        rule('f', 'free_shipping_over', { minSubtotalMinor: next(20_000) }),
      ];
      for (const method of ['online', 'cod'] as const) {
        const out = run(rules, lines, method);
        expect(sum(out.lineDiscounts)).toBe(out.discountMinor);
        expect(sum(out.applied.map((a) => a.savingMinor))).toBe(out.discountMinor);
        out.lineDiscounts.forEach((d, i) => {
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(lines[i].grossMinor);
        });
        expect(out.applied.filter((a) => a.kind !== 'prepaid').length).toBeLessThanOrEqual(1);
        if (method === 'cod') expect(out.applied.some((a) => a.kind === 'prepaid')).toBe(false);
      }
      // Free shipping never depends on the payment method.
      expect(run(rules, lines, 'online').freeShipping).toEqual(run(rules, lines, 'cod').freeShipping);
    }
  });
});
