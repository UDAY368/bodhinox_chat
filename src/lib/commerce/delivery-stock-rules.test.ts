import { describe, expect, it } from 'vitest';
import { parseDeliveryOptions } from './delivery-options';
import {
  availableDeliveryMethods, localDeliveryReaches, priceCart,
  type PricingDeliveryOptions, type PricingSettings, type PricingShippingRate, type PricingVariant,
} from './pricing';
import {
  defaultLocationQuantity, poEditable, poReceivable, poStatusAfterReceipt, poTransition, PO_ACTIONS, PO_STATUSES, receiptProblem, transferProblem,
} from './stock-rules';

// Store plan Phase 8, batch 2: the pure rules for pickup and local delivery, stock transfers and purchase orders.
const variant: PricingVariant = {
  id: 'v1', productId: 'p1', productName: 'Tulsi', sku: 'TUL', optionValues: {}, priceMinor: 10000, taxRateBps: null, hsnCode: null,
  trackInventory: true, sellable: true,
};
const settings = (extra: Partial<PricingSettings> = {}): PricingSettings => ({ currency: 'INR', pricesIncludeTax: false, defaultTaxRateBps: 1000, ...extra });
const rate: PricingShippingRate = {
  id: 'r1', name: 'India', country: 'IN', postalPrefixes: [], minSubtotalMinor: 0, maxSubtotalMinor: null, feeMinor: 5000, taxRateBps: null, position: 0,
};
const options = (extra: Partial<PricingDeliveryOptions> = {}): PricingDeliveryOptions => ({
  pickupEnabled: true, localEnabled: true, localFeeMinor: 2000, localPostalPrefixes: ['560', '5610'], ...extra,
});
const near = { country: 'IN', postalCode: '560 001' };
const far = { country: 'IN', postalCode: '110001' };
const price = (extra: Partial<Parameters<typeof priceCart>[0]> = {}) => priceCart({
  lines: [{ variantId: 'v1', qty: 1 }], variants: [variant], settings: settings(), shippingRates: [rate], coupon: null, address: near, ...extra,
});

describe('delivery options: eligibility', () => {
  it('local delivery reaches only the listed postal prefixes', () => {
    expect(localDeliveryReaches(options(), '560001')).toBe(true);
    expect(localDeliveryReaches(options(), '5610-22')).toBe(true);
    expect(localDeliveryReaches(options(), '561122')).toBe(false);
    expect(localDeliveryReaches(options({ localEnabled: false }), '560001')).toBe(false);
    expect(localDeliveryReaches(options({ localPostalPrefixes: [] }), '560001')).toBe(false);
    expect(localDeliveryReaches(null, '560001')).toBe(false);
  });
  it('lists the methods a buyer can pick', () => {
    expect(availableDeliveryMethods(null, near)).toEqual(['ship']);
    expect(availableDeliveryMethods(options(), near)).toEqual(['ship', 'pickup', 'local']);
    expect(availableDeliveryMethods(options(), far)).toEqual(['ship', 'pickup']);
    expect(availableDeliveryMethods(options(), null)).toEqual(['ship', 'pickup', 'local']);
    expect(availableDeliveryMethods(options({ pickupEnabled: false }), far)).toEqual(['ship']);
  });
});

describe('delivery options: pricing', () => {
  it('ships at the shipping rate when no method is chosen (unchanged)', () => {
    const r = price();
    expect(r.ok && r.quote).toMatchObject({ deliveryMethod: 'ship', shippingMinor: 5000, taxMinor: 1500, totalMinor: 16500 });
  });
  it('pickup is free and needs no shipping rate', () => {
    const r = price({ deliveryMethod: 'pickup', deliveryOptions: options(), shippingRates: [] });
    expect(r.ok && r.quote).toMatchObject({ deliveryMethod: 'pickup', shipping: { rateId: 'pickup', feeMinor: 0, taxMinor: 0 }, shippingMinor: 0, taxMinor: 1000, totalMinor: 11000 });
  });
  it('local delivery charges the store fee, taxed at the default rate', () => {
    const r = price({ deliveryMethod: 'local', deliveryOptions: options() });
    expect(r.ok && r.quote).toMatchObject({ deliveryMethod: 'local', shipping: { rateId: 'local', feeMinor: 2000, taxRateBps: 1000, taxMinor: 200 }, shippingMinor: 2000, taxMinor: 1200, totalMinor: 13200 });
    const inclusive = price({ deliveryMethod: 'local', deliveryOptions: options(), settings: settings({ pricesIncludeTax: true }) });
    expect(inclusive.ok && inclusive.quote.totalMinor).toBe(12000);
  });
  it('refuses a method the store does not offer or that does not reach the address', () => {
    expect(price({ deliveryMethod: 'pickup' })).toEqual({ ok: false, code: 'delivery_unavailable' });
    expect(price({ deliveryMethod: 'pickup', deliveryOptions: options({ pickupEnabled: false }) })).toEqual({ ok: false, code: 'delivery_unavailable' });
    expect(price({ deliveryMethod: 'local', deliveryOptions: options({ localEnabled: false }) })).toEqual({ ok: false, code: 'delivery_unavailable' });
    expect(price({ deliveryMethod: 'local', deliveryOptions: options(), address: far })).toEqual({ ok: false, code: 'delivery_unavailable' });
  });
  it('a local fee without any tax rate is refused, a free one is not', () => {
    const untaxed = { settings: settings({ defaultTaxRateBps: null }), variants: [{ ...variant, taxRateBps: 0 }] };
    expect(price({ deliveryMethod: 'local', deliveryOptions: options(), ...untaxed })).toEqual({ ok: false, code: 'tax_not_configured' });
    const free = price({ deliveryMethod: 'local', deliveryOptions: options({ localFeeMinor: 0 }), ...untaxed });
    expect(free.ok && free.quote.totalMinor).toBe(10000);
  });
  it('has no delivery line until the address is known', () => {
    const r = price({ deliveryMethod: 'local', deliveryOptions: options(), address: null });
    expect(r.ok && r.quote).toMatchObject({ deliveryMethod: 'local', shipping: null, shippingMinor: 0 });
  });
  it('a free-shipping rule waives the local delivery fee too', () => {
    const r = price({
      deliveryMethod: 'local', deliveryOptions: options(),
      autoDiscounts: [{ id: 'a1', name: 'Free delivery', kind: 'free_shipping_over', minSubtotalMinor: 5000, amountMinor: null, percentBps: null,
        buyQty: null, getQty: null, productIds: [], active: true, startsAt: null, endsAt: null }],
    });
    expect(r.ok && r.quote).toMatchObject({ shippingMinor: 0, totalMinor: 11000 });
  });
});

describe('parseDeliveryOptions', () => {
  const body = { pickup_enabled: true, pickup_address: ' 1 MG Road ', pickup_instructions: '', local_enabled: true, local_fee_minor: 2500, local_postal_prefixes: ['560 ', '560', '5610-2'] };
  it('normalises a valid body', () => {
    expect(parseDeliveryOptions(body)).toEqual({
      pickup_enabled: true, pickup_address: '1 MG Road', pickup_instructions: null, local_enabled: true, local_fee_minor: 2500, local_postal_prefixes: ['560', '56102'],
    });
  });
  it('refuses pickup without an address, local delivery without a prefix, and bad amounts', () => {
    expect(() => parseDeliveryOptions({ ...body, pickup_address: ' ' })).toThrow();
    expect(() => parseDeliveryOptions({ ...body, local_postal_prefixes: [] })).toThrow();
    expect(() => parseDeliveryOptions({ ...body, local_postal_prefixes: ['56*'] })).toThrow();
    expect(() => parseDeliveryOptions({ ...body, local_fee_minor: -1 })).toThrow();
    expect(() => parseDeliveryOptions({ ...body, local_fee_minor: 10.5 })).toThrow();
    expect(() => parseDeliveryOptions({ ...body, pickup_enabled: 'yes' })).toThrow();
    expect(() => parseDeliveryOptions(null)).toThrow();
  });
});

describe('stock transfers', () => {
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', v = '33333333-3333-4333-8333-333333333333';
  const ok = { clientKey: 'transfer-key-1', fromLocationId: a, toLocationId: b, variantId: v, quantity: 3 };
  it('accepts a well-formed request', () => expect(transferProblem(ok)).toBeNull());
  it('names the malformed field', () => {
    expect(transferProblem({ ...ok, clientKey: 'short' })).toBe('client_key');
    expect(transferProblem({ ...ok, clientKey: 'has spaces in it' })).toBe('client_key');
    expect(transferProblem({ ...ok, fromLocationId: 'x' })).toBe('from_location_id');
    expect(transferProblem({ ...ok, toLocationId: a.toUpperCase() })).toBe('to_location_id');
    expect(transferProblem({ ...ok, variantId: null })).toBe('variant_id');
    for (const quantity of [0, -1, 1.5, 1_000_001, '3']) expect(transferProblem({ ...ok, quantity })).toBe('quantity');
  });
  it('the default location holds what is not counted elsewhere', () => {
    expect(defaultLocationQuantity(10, [])).toBe(10);
    expect(defaultLocationQuantity(10, [3, 4])).toBe(3);
    expect(defaultLocationQuantity(7, [7])).toBe(0);
  });
});

describe('purchase order state machine', () => {
  it('allows only the listed steps', () => {
    const allowed: Record<string, string> = {
      'draft:order': 'ordered', 'draft:cancel': 'cancelled', 'ordered:cancel': 'cancelled', 'partially_received:close': 'closed', 'received:close': 'closed',
    };
    for (const status of PO_STATUSES) for (const action of PO_ACTIONS)
      expect(poTransition(status, action), `${status}:${action}`).toBe(allowed[`${status}:${action}`] ?? null);
  });
  it('edits only a draft and receives only a placed, incomplete order', () => {
    expect(PO_STATUSES.filter(poEditable)).toEqual(['draft']);
    expect(PO_STATUSES.filter(poReceivable)).toEqual(['ordered', 'partially_received']);
  });
  it('is received only when every line is complete', () => {
    expect(poStatusAfterReceipt([{ qtyOrdered: 5, qtyReceived: 5 }, { qtyOrdered: 2, qtyReceived: 1 }])).toBe('partially_received');
    expect(poStatusAfterReceipt([{ qtyOrdered: 5, qtyReceived: 5 }, { qtyOrdered: 2, qtyReceived: 2 }])).toBe('received');
    expect(poStatusAfterReceipt([])).toBe('partially_received');
  });
  it('checks a receive request', () => {
    const lines = [{ id: 'l1', qtyOrdered: 5, qtyReceived: 2 }, { id: 'l2', qtyOrdered: 1, qtyReceived: 1 }];
    expect(receiptProblem('ordered', lines, [{ lineId: 'l1', quantity: 3 }])).toBeNull();
    expect(receiptProblem('partially_received', lines, [{ lineId: 'l1', quantity: 4 }])).toBe('over_receive');
    expect(receiptProblem('ordered', lines, [{ lineId: 'l2', quantity: 1 }])).toBe('over_receive');
    for (const status of ['draft', 'received', 'closed', 'cancelled'] as const)
      expect(receiptProblem(status, lines, [{ lineId: 'l1', quantity: 1 }])).toBe('po_state');
    expect(receiptProblem('ordered', lines, [])).toBe('invalid');
    expect(receiptProblem('ordered', lines, [{ lineId: 'nope', quantity: 1 }])).toBe('invalid');
    expect(receiptProblem('ordered', lines, [{ lineId: 'l1', quantity: 1 }, { lineId: 'l1', quantity: 1 }])).toBe('invalid');
    expect(receiptProblem('ordered', lines, [{ lineId: 'l1', quantity: 0 }])).toBe('invalid');
    expect(receiptProblem('ordered', lines, [{ lineId: 'l1', quantity: 1.5 }])).toBe('invalid');
  });
});
