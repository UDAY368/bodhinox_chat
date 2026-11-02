import { describe, expect, it } from 'vitest';
import {
  buildWooCommerceInputs,
  isWooTopic,
  parseWooOrder,
  wooEventPayload,
  wooMarketingConsent,
  wooOrderEvents,
  wooPhoneToInternational,
} from './mapping';
import { normalizeStoreUrl } from './stores';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';

const orderBody = (over: Record<string, unknown> = {}) => ({
  id: 1001,
  number: '1001',
  status: 'processing',
  currency: 'INR',
  total: '1499.50',
  date_paid_gmt: '2026-11-02T10:00:00',
  payment_method_title: 'UPI',
  payment_url: 'https://shop.example.com/checkout/order-pay/1001',
  billing: { first_name: 'Asha', last_name: 'Rao', phone: '098765 43210', email: 'asha@example.com', country: 'IN', address_1: 'secret street' },
  shipping: { phone: '' },
  line_items: [{ quantity: 2, name: 'Tea' }, { quantity: 1, name: 'Cup' }],
  meta_data: [{ id: 1, key: '_wa_opt_in', value: 'yes' }],
  ...over,
});

describe('parseWooOrder', () => {
  it('reads the fields we use and nothing else', () => {
    const o = parseWooOrder(orderBody())!;
    expect(o).toMatchObject({ id: '1001', number: '1001', status: 'processing', currency: 'INR', total: '1499.50', itemCount: 3 });
    expect(JSON.stringify(o)).not.toContain('secret street');
  });

  it('accepts the legacy { order } wrapper and refuses bodies without a numeric id', () => {
    expect(parseWooOrder({ order: orderBody() })?.id).toBe('1001');
    expect(parseWooOrder({ id: 'abc' })).toBeNull();
    expect(parseWooOrder(null)).toBeNull();
    expect(parseWooOrder([])).toBeNull();
  });

  it('drops a non-https payment url', () => {
    expect(parseWooOrder(orderBody({ payment_url: 'http://shop.example.com/pay' }))?.paymentUrl).toBeNull();
  });
});

describe('wooOrderEvents', () => {
  it('maps topics and statuses', () => {
    expect(wooOrderEvents('order.created', { status: 'pending', datePaid: null })).toEqual(['order_created']);
    expect(wooOrderEvents('order.created', { status: 'processing', datePaid: '2026-11-02' })).toEqual(['order_created', 'order_paid']);
    expect(wooOrderEvents('order.updated', { status: 'processing', datePaid: '2026-11-02' })).toEqual(['order_paid']);
    expect(wooOrderEvents('order.updated', { status: 'completed', datePaid: null })).toEqual(['order_fulfilled']);
    expect(wooOrderEvents('order.updated', { status: 'cancelled', datePaid: null })).toEqual(['order_cancelled']);
    expect(wooOrderEvents('order.updated', { status: 'on-hold', datePaid: null })).toEqual([]);
  });

  it('does not call an unpaid cash-on-delivery order paid', () => {
    expect(wooOrderEvents('order.updated', { status: 'processing', datePaid: null })).toEqual([]);
  });

  it('knows its topics', () => {
    expect(isWooTopic('order.created')).toBe(true);
    expect(isWooTopic('product.updated')).toBe(false);
  });
});

describe('wooPhoneToInternational', () => {
  it('keeps international numbers and completes national ones from the billing country', () => {
    expect(wooPhoneToInternational('+91 98765 43210', 'US')).toBe('+919876543210');
    expect(wooPhoneToInternational('0091 98765 43210', '')).toBe('+919876543210');
    expect(wooPhoneToInternational('098765 43210', 'IN')).toBe('+919876543210');
    expect(wooPhoneToInternational('9876543210', 'IN')).toBe('+919876543210');
    expect(wooPhoneToInternational('919876543210', 'IN')).toBe('+919876543210');
    expect(wooPhoneToInternational('(415) 555-1212', 'US')).toBe('+14155551212');
    expect(wooPhoneToInternational('07911 123456', 'GB')).toBe('+447911123456');
  });

  it('refuses to guess without a known country, and refuses junk', () => {
    expect(wooPhoneToInternational('9876543210', '')).toBeNull();
    expect(wooPhoneToInternational('9876543210', 'XX')).toBeNull();
    expect(wooPhoneToInternational('call me', 'IN')).toBeNull();
    expect(wooPhoneToInternational('', 'IN')).toBeNull();
  });
});

describe('wooMarketingConsent', () => {
  const meta = [{ key: '_wa_opt_in', value: 'yes' }, { key: 'no_key', value: 'no' }, { key: 'b', value: false }, { key: 'odd', value: { x: 1 } }];
  it('reads the configured key only', () => {
    expect(wooMarketingConsent(meta, null)).toBeNull();
    expect(wooMarketingConsent(meta, '_wa_opt_in')).toBe(true);
    expect(wooMarketingConsent(meta, 'no_key')).toBe(false);
    expect(wooMarketingConsent(meta, 'b')).toBe(false);
    expect(wooMarketingConsent(meta, 'odd')).toBeNull();
    expect(wooMarketingConsent(meta, 'missing')).toBeNull();
  });
});

describe('wooEventPayload', () => {
  it('keeps exact minor units and drops unreadable totals', () => {
    const o = parseWooOrder(orderBody())!;
    expect(wooEventPayload(o, 'https://shop.example.com')).toEqual({
      order_id: '1001', order_number: '1001', order_status: 'processing', item_count: 3, store_url: 'https://shop.example.com',
      currency: 'INR', total_minor: 149950, payment_method: 'UPI', payment_url: 'https://shop.example.com/checkout/order-pay/1001',
    });
    expect(wooEventPayload(parseWooOrder(orderBody({ currency: 'JPY', total: '1000.00' }))!, 'x').total_minor).toBe(1000);
    expect(wooEventPayload(parseWooOrder(orderBody({ total: '1.999' }))!, 'x').total_minor).toBeUndefined();
    expect(wooEventPayload(parseWooOrder(orderBody({ currency: '' }))!, 'x').currency).toBeUndefined();
  });
});

describe('buildWooCommerceInputs', () => {
  it('builds deduplicated recordCommerceEvent inputs per order event', () => {
    const order = parseWooOrder(orderBody())!;
    const inputs = buildWooCommerceInputs({
      accountId: ACCOUNT, storeId: STORE, storeUrl: 'https://shop.example.com', consentMetaKey: '_wa_opt_in', topic: 'order.created', order,
    });
    expect(inputs.map((i) => i.event)).toEqual(['order_created', 'order_paid']);
    expect(inputs[1]).toMatchObject({
      accountId: ACCOUNT, source: 'woocommerce', externalId: '1001', dedupeKey: `woocommerce:${STORE}:1001:order_paid`,
      phone: '+919876543210', name: 'Asha Rao', email: 'asha@example.com', marketingConsent: true,
    });
  });

  it('falls back to the shipping phone and leaves consent unknown without a key', () => {
    const order = parseWooOrder(orderBody({ billing: { phone: '', country: 'IN' }, shipping: { phone: '+919000000001' } }))!;
    const [input] = buildWooCommerceInputs({
      accountId: ACCOUNT, storeId: STORE, storeUrl: 'https://s.example', consentMetaKey: null, topic: 'order.updated', order,
    });
    expect(input).toMatchObject({ event: 'order_paid', phone: '+919000000001', marketingConsent: null, name: null });
  });
});

describe('normalizeStoreUrl', () => {
  it('normalises and refuses bad urls', () => {
    expect(normalizeStoreUrl('https://Shop.Example.com/store/')).toBe('https://shop.example.com/store');
    expect(normalizeStoreUrl(' http://shop.example.com ')).toBe('http://shop.example.com');
    expect(normalizeStoreUrl('ftp://shop.example.com')).toBeNull();
    expect(normalizeStoreUrl('https://user:pw@shop.example.com')).toBeNull();
    expect(normalizeStoreUrl('https://intranet')).toBeNull();
    expect(normalizeStoreUrl('not a url')).toBeNull();
    expect(normalizeStoreUrl(42)).toBeNull();
  });
});
