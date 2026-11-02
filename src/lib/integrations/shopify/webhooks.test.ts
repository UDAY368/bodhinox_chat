import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { registerWebhooks, revokeAccess, SHOPIFY_EVENT_TOPICS } from './admin-api';
import { customerEmailKey, mapShopifyEvent, mapTopic, shopifyMarketingConsent, verifyWebhookHmac } from './webhooks';

const shop = 'demo.myshopify.com';
const order = {
  id: 450789469,
  name: '#1001',
  email: 'Asha@Example.com',
  phone: null,
  currency: 'INR',
  total_price: '1234.50',
  subtotal_price: '1100.00',
  order_status_url: 'https://demo.myshopify.com/orders/abc',
  checkout_token: 'ck_123',
  financial_status: 'paid',
  fulfillment_status: null,
  line_items: [{ quantity: 2, title: 'Mug' }, { quantity: 1 }],
  billing_address: { first_name: 'Asha', last_name: 'R', address1: '1 Secret Street', phone: '98765 43210' },
  shipping_address: { phone: '+919876543210', address1: '1 Secret Street' },
  customer: { id: 207119551, first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', sms_marketing_consent: { state: 'subscribed' } },
  fulfillments: [{ tracking_url: 'https://track.example/1', tracking_number: 'T1', tracking_company: 'BlueDart' }],
};

describe('webhook HMAC', () => {
  const raw = Buffer.from(JSON.stringify(order));
  const header = createHmac('sha256', 'app-secret').update(raw).digest('base64');
  it('accepts the base64 HMAC of the raw body', () => {
    expect(verifyWebhookHmac(raw, header, 'app-secret')).toBe(true);
    expect(verifyWebhookHmac(raw.toString('utf8'), header, 'app-secret')).toBe(true);
  });
  it('rejects the wrong secret, a changed body, a missing or malformed header', () => {
    expect(verifyWebhookHmac(raw, header, 'other')).toBe(false);
    expect(verifyWebhookHmac(Buffer.concat([raw, Buffer.from(' ')]), header, 'app-secret')).toBe(false);
    expect(verifyWebhookHmac(raw, null, 'app-secret')).toBe(false);
    expect(verifyWebhookHmac(raw, 'not-base64!!', 'app-secret')).toBe(false);
    expect(verifyWebhookHmac(raw, header, '')).toBe(false);
  });
});

describe('topic mapping', () => {
  it('maps order and checkout topics and nothing else', () => {
    expect(mapTopic('orders/create')).toBe('order_created');
    expect(mapTopic('orders/paid')).toBe('order_paid');
    expect(mapTopic('orders/fulfilled')).toBe('order_fulfilled');
    expect(mapTopic('orders/cancelled')).toBe('order_cancelled');
    expect(mapTopic('checkouts/create')).toBe('checkout_abandoned');
    expect(mapTopic('checkouts/update')).toBe('checkout_abandoned');
    expect(mapTopic('app/uninstalled')).toBeNull();
    expect(mapTopic('customers/redact')).toBeNull();
    expect(mapTopic('toString')).toBeNull();
  });

  it('maps an order to template-safe fields only', () => {
    const input = mapShopifyEvent('orders/fulfilled', order, shop, { marketingOptInOnly: true })!;
    expect(input).toMatchObject({
      source: 'shopify', event: 'order_fulfilled', externalId: '450789469', dedupeKey: `shopify:${shop}:order_fulfilled:450789469`,
      phone: '+919876543210', name: 'Asha Rao', email: 'Asha@Example.com', marketingConsent: true,
    });
    expect(input.payload).toEqual({
      shop_domain: shop, customer_first_name: 'Asha', customer_id: '207119551', customer_email_key: customerEmailKey(shop, 'asha@example.com'),
      currency: 'INR', item_count: 3, total_minor: 123450, subtotal_minor: 110000, order_id: '450789469', order_number: '#1001',
      status_url: 'https://demo.myshopify.com/orders/abc', checkout_token: 'ck_123', financial_status: 'paid',
      tracking_url: 'https://track.example/1', tracking_number: 'T1', carrier: 'BlueDart',
    });
    // No address or raw email in the stored payload.
    expect(JSON.stringify(input.payload)).not.toMatch(/Secret Street|example\.com/i);
  });

  it('keeps one abandoned-checkout event per token and waits for a phone', () => {
    const checkout = { token: 'ck_123', abandoned_checkout_url: 'https://demo.myshopify.com/recover', currency: 'INR', total_price: '10.00', phone: '+919876543210', buyer_accepts_marketing: true };
    const created = mapShopifyEvent('checkouts/create', checkout, shop, { marketingOptInOnly: true })!;
    const updated = mapShopifyEvent('checkouts/update', { ...checkout, total_price: '12.00' }, shop, { marketingOptInOnly: true })!;
    expect(created.dedupeKey).toBe(updated.dedupeKey);
    expect(created).toMatchObject({ event: 'checkout_abandoned', externalId: 'ck_123', marketingConsent: true });
    expect(created.payload).toMatchObject({ checkout_token: 'ck_123', checkout_url: 'https://demo.myshopify.com/recover', total_minor: 1000 });
    expect(mapShopifyEvent('checkouts/create', { ...checkout, phone: null }, shop, { marketingOptInOnly: true })).toBeNull();
    expect(mapShopifyEvent('checkouts/update', { ...checkout, completed_at: '2026-11-02T10:00:00Z' }, shop, { marketingOptInOnly: true })).toBeNull();
    expect(mapShopifyEvent('checkouts/update', { ...checkout, token: 'bad token' }, shop, { marketingOptInOnly: true })).toBeNull();
  });

  it('refuses an order without a numeric id and ignores an unknown currency amount', () => {
    expect(mapShopifyEvent('orders/paid', { ...order, id: 'x' }, shop, { marketingOptInOnly: true })).toBeNull();
    const input = mapShopifyEvent('orders/paid', { ...order, currency: 'rupees' }, shop, { marketingOptInOnly: true })!;
    expect(input.payload.total_minor).toBeUndefined();
  });
});

describe('marketing consent', () => {
  it('uses SMS consent first, then email, then accepts_marketing', () => {
    expect(shopifyMarketingConsent({ customer: { sms_marketing_consent: { state: 'unsubscribed' }, email_marketing_consent: { state: 'subscribed' } } })).toBe(false);
    expect(shopifyMarketingConsent({ customer: { email_marketing_consent: { state: 'subscribed' } } })).toBe(true);
    expect(shopifyMarketingConsent({ customer: { email_marketing_consent: { state: 'not_subscribed' }, accepts_marketing: true } })).toBe(false);
    expect(shopifyMarketingConsent({ customer: { accepts_marketing: true } })).toBe(true);
    expect(shopifyMarketingConsent({ buyer_accepts_marketing: false })).toBe(false);
    expect(shopifyMarketingConsent({ customer: { sms_marketing_consent: { state: 'pending' } } })).toBeNull();
    expect(shopifyMarketingConsent({})).toBeNull();
  });
  it('treats unknown consent as no when the store is opt-in only', () => {
    const unknown = { ...order, customer: { ...order.customer, sms_marketing_consent: undefined } };
    expect(mapShopifyEvent('orders/create', unknown, shop, { marketingOptInOnly: true })!.marketingConsent).toBe(false);
    expect(mapShopifyEvent('orders/create', unknown, shop, { marketingOptInOnly: false })!.marketingConsent).toBeNull();
  });
});

describe('admin API', () => {
  it('registers every topic and counts an existing subscription as done', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const topic = JSON.parse(String(init.body)).webhook.topic;
      if (topic === 'orders/paid') return new Response('{"errors":{"address":["for this topic has already been taken"]}}', { status: 422 });
      if (topic === 'checkouts/update') return new Response('{}', { status: 500 });
      return new Response('{}', { status: 201 });
    });
    const result = await registerWebhooks({ shop, accessToken: 'shpat_test', address: 'https://app.test/api/integrations/shopify/webhooks', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.failed).toEqual(['checkouts/update']);
    expect(fetchImpl).toHaveBeenCalledTimes(SHOPIFY_EVENT_TOPICS.length);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^https:\/\/demo\.myshopify\.com\/admin\/api\/\d{4}-\d{2}\/webhooks\.json$/);
    expect((init.headers as Record<string, string>)['x-shopify-access-token']).toBe('shpat_test');
  });
  it('treats an already revoked token as uninstalled and a network error as not', async () => {
    const gone = vi.fn(async () => new Response('', { status: 401 }));
    expect(await revokeAccess({ shop, accessToken: 't', fetchImpl: gone as unknown as typeof fetch })).toBe(true);
    const offline = vi.fn(async () => { throw new TypeError('offline'); });
    expect(await revokeAccess({ shop, accessToken: 't', fetchImpl: offline as unknown as typeof fetch })).toBe(false);
    await expect(registerWebhooks({ shop: 'evil.com', accessToken: 't', address: 'x', fetchImpl: gone as unknown as typeof fetch }))
      .resolves.toEqual({ failed: [...SHOPIFY_EVENT_TOPICS] });
  });
});
