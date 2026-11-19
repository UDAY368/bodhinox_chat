import { describe, expect, it } from 'vitest';
import { priceCart, type PricingVariant } from './pricing';
import {
  bundleAvailability, expandBundleLines, formatShipDate, isShopAccessMode, latestShipDate, parseScheduleTime, parseShipDate, preorderProblem,
  productLive, reserveFromStock, scheduleProblem, withinPreorderCap,
} from './selling-rules';

const NOW = new Date('2026-12-05T10:00:00Z');
const at = (iso: string) => new Date(iso);

describe('scheduled publish and hide', () => {
  it('shows a published product only inside its window', () => {
    expect(productLive('published', null, null, NOW)).toBe(true);
    expect(productLive('published', at('2026-12-05T09:59:59Z'), null, NOW)).toBe(true);
    expect(productLive('published', at('2026-12-05T10:00:01Z'), null, NOW)).toBe(false);
    // publish_at is inclusive, hide_at is exclusive: the product is gone at the hide time.
    expect(productLive('published', at('2026-12-05T10:00:00Z'), null, NOW)).toBe(true);
    expect(productLive('published', null, at('2026-12-05T10:00:00Z'), NOW)).toBe(false);
    expect(productLive('published', null, at('2026-12-05T10:00:01Z'), NOW)).toBe(true);
    expect(productLive('published', at('2026-12-01T00:00:00Z'), at('2026-12-04T00:00:00Z'), NOW)).toBe(false);
  });

  it('never shows a draft or archived product, whatever its schedule', () => {
    expect(productLive('draft', at('2026-01-01T00:00:00Z'), null, NOW)).toBe(false);
    expect(productLive('archived', null, null, NOW)).toBe(false);
  });

  it('wants the hide time after the publish time', () => {
    expect(scheduleProblem(at('2026-12-01T00:00:00Z'), at('2026-12-02T00:00:00Z'))).toBeNull();
    expect(scheduleProblem(at('2026-12-02T00:00:00Z'), at('2026-12-02T00:00:00Z'))).toBe('order');
    expect(scheduleProblem(at('2026-12-03T00:00:00Z'), at('2026-12-02T00:00:00Z'))).toBe('order');
    expect(scheduleProblem(null, at('2026-12-02T00:00:00Z'))).toBeNull();
    expect(scheduleProblem(at('2026-12-02T00:00:00Z'), null)).toBeNull();
  });

  it('reads a schedule time from the browser: a date-time, empty for none, undefined for nonsense', () => {
    expect(parseScheduleTime('2026-12-25T08:30:00.000Z')?.toISOString()).toBe('2026-12-25T08:30:00.000Z');
    expect(parseScheduleTime(null)).toBeNull();
    expect(parseScheduleTime('')).toBeNull();
    expect(parseScheduleTime('soon')).toBeUndefined();
    expect(parseScheduleTime(12)).toBeUndefined();
    expect(parseScheduleTime('x'.repeat(41))).toBeUndefined();
  });
});

describe('pre-order rules', () => {
  it('accepts only real calendar dates', () => {
    expect(parseShipDate('2026-12-31')).toBe('2026-12-31');
    expect(parseShipDate('2026-02-30')).toBeNull();
    expect(parseShipDate('2026-13-01')).toBeNull();
    expect(parseShipDate('31/12/2026')).toBeNull();
    expect(parseShipDate(null)).toBeNull();
  });

  it('needs a ship date when on, and a whole cap of 1 or more', () => {
    expect(preorderProblem({ preorder: false, shipDate: null, cap: null })).toBeNull();
    expect(preorderProblem({ preorder: true, shipDate: null, cap: null })).toBe('ship_date');
    expect(preorderProblem({ preorder: true, shipDate: '2026-12-31', cap: null })).toBeNull();
    expect(preorderProblem({ preorder: true, shipDate: '2026-12-31', cap: 0 })).toBe('cap');
    expect(preorderProblem({ preorder: true, shipDate: '2026-12-31', cap: 1.5 })).toBe('cap');
    expect(preorderProblem({ preorder: true, shipDate: '2026-12-31', cap: 2_000_000 })).toBe('cap');
    expect(preorderProblem({ preorder: false, shipDate: null, cap: 5 })).toBeNull();
  });

  it('checks the cap against the open pre-order units, this order included', () => {
    expect(withinPreorderCap(null, 1_000_000)).toBe(true);
    expect(withinPreorderCap(5, 5)).toBe(true);
    expect(withinPreorderCap(5, 6)).toBe(false);
  });

  it('promises the latest of the lines ship dates for the order', () => {
    expect(latestShipDate([null, '2026-12-20', '2027-01-05', null])).toBe('2027-01-05');
    expect(latestShipDate([null, null])).toBeNull();
    expect(latestShipDate([])).toBeNull();
  });

  it('sells past zero stock only on a pre-order variant, and never a short bundle part', () => {
    // Plain variant: all or nothing.
    expect(reserveFromStock({ quantity: 3, viaBundle: 0 }, 3, false)).toBe(3);
    expect(reserveFromStock({ quantity: 3, viaBundle: 0 }, 2, false)).toBeNull();
    // Pre-order variant: reserve what is on the shelf; with none, reserve nothing and still sell.
    expect(reserveFromStock({ quantity: 3, viaBundle: 0 }, 2, true)).toBe(2);
    expect(reserveFromStock({ quantity: 3, viaBundle: 0 }, 0, true)).toBe(0);
    expect(reserveFromStock({ quantity: 3, viaBundle: 0 }, -4, true)).toBe(0);
    // Units that came from a bundle must be in stock even when the variant is on pre-order.
    expect(reserveFromStock({ quantity: 5, viaBundle: 2 }, 1, true)).toBeNull();
    expect(reserveFromStock({ quantity: 5, viaBundle: 2 }, 3, true)).toBe(3);
  });

  it('formats a ship date as that day in the reader language', () => {
    expect(formatShipDate('2026-12-31', 'en')).toContain('2026');
    expect(formatShipDate('2026-12-31', 'en')).toContain('31');
    expect(formatShipDate('not a date', 'en')).toBe('not a date');
  });
});

describe('bundle rules', () => {
  it('is what the scarcest part allows', () => {
    expect(bundleAvailability([{ quantity: 2, available: 7 }, { quantity: 1, available: 3 }])).toBe(3);
    expect(bundleAvailability([{ quantity: 2, available: 7 }, { quantity: 4, available: 7 }])).toBe(1);
    expect(bundleAvailability([{ quantity: 2, available: 1 }])).toBe(0);
  });

  it('is not limited by a made-to-order part, and is unlimited when every part is', () => {
    expect(bundleAvailability([{ quantity: 1, available: null }, { quantity: 3, available: 10 }])).toBe(3);
    expect(bundleAvailability([{ quantity: 1, available: null }])).toBeNull();
  });

  it('sells nothing without parts or with an archived part', () => {
    expect(bundleAvailability([])).toBe(0);
    expect(bundleAvailability([{ quantity: 1, available: 50 }, { quantity: 1, available: 50, archived: true }])).toBe(0);
    expect(bundleAvailability([{ quantity: 1, available: -3 }])).toBe(0);
  });

  const parts: Record<string, Array<{ variantId: string; quantity: number }>> = {
    '00000000-0000-4000-8000-0000000000b1': [
      { variantId: '00000000-0000-4000-8000-000000000a02', quantity: 2 }, { variantId: '00000000-0000-4000-8000-000000000a01', quantity: 1 },
    ],
  };
  const BUNDLE = '00000000-0000-4000-8000-0000000000b1', A1 = '00000000-0000-4000-8000-000000000a01', A2 = '00000000-0000-4000-8000-000000000a02';

  it('turns bundle lines into part needs in lock order, merging a part that is also bought on its own', () => {
    const needs = expandBundleLines([{ variantId: BUNDLE, quantity: 3 }, { variantId: A1, quantity: 4 }], (id) => parts[id] ?? null);
    expect(needs).toEqual([
      { variantId: A1, quantity: 7, viaBundle: 3 },
      { variantId: A2, quantity: 6, viaBundle: 6 },
    ]);
    expect(expandBundleLines([{ variantId: A1, quantity: 1 }], () => null)).toEqual([{ variantId: A1, quantity: 1, viaBundle: 0 }]);
  });
});

describe('shop access modes', () => {
  it('knows the three modes', () => {
    expect(['open', 'password', 'coming_soon'].every(isShopAccessMode)).toBe(true);
    expect(isShopAccessMode('closed')).toBe(false);
    expect(isShopAccessMode(null)).toBe(false);
  });
});

describe('pricing with selling options', () => {
  const settings = { currency: 'INR', pricesIncludeTax: false, defaultTaxRateBps: 1800, codEnabled: true, codFeeMinor: 4_900 };
  const rate = { id: 'r1', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 5_000, taxRateBps: null, position: 0 };
  const variant = (id: string, priceMinor: number, extra: Partial<PricingVariant> = {}): PricingVariant => ({
    id, productId: `p-${id}`, productName: `Product ${id}`, sku: `SKU-${id}`, optionValues: {}, priceMinor, taxRateBps: null, hsnCode: null,
    trackInventory: true, sellable: true, ...extra,
  });
  const price = (variants: PricingVariant[], extra: Record<string, unknown> = {}) => {
    const result = priceCart({
      lines: variants.map((v) => ({ variantId: v.id, qty: 1 })), variants, settings, shippingRates: [rate], coupon: null, address: null, now: NOW, ...extra,
    });
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    return result.quote;
  };

  it('prices a cart of only digital products with no address and no shipping', () => {
    const quote = price([variant('d', 20_000, { digital: true, trackInventory: false })]);
    expect(quote).toMatchObject({ digitalOnly: true, deliveryMethod: 'ship', shippingMinor: 0, subtotalMinor: 20_000, taxMinor: 3_600, totalMinor: 23_600 });
    expect(quote.shipping).toMatchObject({ rateId: 'digital', feeMinor: 0 });
  });

  it('ignores pickup and local delivery for a digital cart, and refuses cash on delivery for it', () => {
    const quote = price([variant('d', 20_000, { digital: true })], { deliveryMethod: 'pickup' });
    expect(quote).toMatchObject({ deliveryMethod: 'ship', shippingMinor: 0 });
    const cod = priceCart({ lines: [{ variantId: 'd', qty: 1 }], variants: [variant('d', 20_000, { digital: true })], settings, shippingRates: [rate], coupon: null, address: null, paymentMethod: 'cod', now: NOW });
    expect(cod).toEqual({ ok: false, code: 'cod_unavailable' });
  });

  it('still needs an address and a rate once a physical product is in the cart', () => {
    const mixed = price([variant('d', 20_000, { digital: true }), variant('p', 10_000)]);
    expect(mixed).toMatchObject({ digitalOnly: false, shipping: null });
    const shipped = price([variant('d', 20_000, { digital: true }), variant('p', 10_000)], { address: { country: 'IN', postalCode: '560001' } });
    expect(shipped).toMatchObject({ shippingMinor: 5_000 });
  });

  it('carries a pre-order ship date to the line and the latest to the quote', () => {
    const quote = price([variant('a', 10_000, { preorderShipDate: '2026-12-20' }), variant('b', 10_000, { preorderShipDate: '2027-01-10' }), variant('c', 10_000)],
      { address: { country: 'IN', postalCode: '560001' } });
    expect(quote.lines.map((l) => l.preorderShipDate)).toEqual(['2026-12-20', '2027-01-10', null]);
    expect(quote.preorderShipDate).toBe('2027-01-10');
    expect(price([variant('a', 10_000)], { address: { country: 'IN', postalCode: '560001' } }).preorderShipDate).toBeNull();
  });

  it('prices a bundle at its own price, like any variant', () => {
    // The bundle variant carries the bundle price; its parts never appear in the quote.
    const quote = price([variant('bundle', 45_000)], { address: { country: 'IN', postalCode: '560001' } });
    expect(quote.lines).toHaveLength(1);
    expect(quote).toMatchObject({ subtotalMinor: 45_000, taxMinor: 8_100 + 900, totalMinor: 45_000 + 5_000 + 9_000 });
  });
});
