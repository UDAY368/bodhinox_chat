import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { fixtures, login } from './fixtures';

// Phase 8 storefront and order journey (design section 8, E2E). The seed
// (global-setup seedCommerce) has a published product with exactly one unit
// in stock, two live storefront links for two contacts, and a paid order with
// its settled payment and receipt. E2E runs no worker, so a placed order stays
// awaiting payment with its link "being prepared"; the payment itself is
// proven by the real-database settlement tests, never by a success page.

const shop = (token: string, path = '') => `/api/public/shop/${token}${path}`;
const address = {
  name: 'E2E Shopper', phone: '+919900000001', line1: '2 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: '29', postal_code: '560001', country: 'IN', instructions: null,
};

/** Cart, address and quote through the public API (the same calls the storefront page makes). */
async function prepareCheckout(request: APIRequestContext, origin: string, token: string, variantId: string) {
  const headers = { origin };
  const viewResponse = await request.get(shop(token));
  expect(viewResponse.status()).toBe(200);
  let view = await viewResponse.json();
  const cart = await request.put(shop(token, '/cart'), { headers, data: { expectedVersion: view.version, lines: [{ variantId, qty: 1 }] } });
  expect(cart.status()).toBe(200);
  view = await cart.json();
  const withAddress = await request.put(shop(token, '/address'), { headers, data: { expectedVersion: view.version, address } });
  expect(withAddress.status()).toBe(200);
  view = await withAddress.json();
  const quoteResponse = await request.post(shop(token, '/quote'), { headers, data: {} });
  expect(quoteResponse.status()).toBe(200);
  const { quote } = await quoteResponse.json();
  return { version: view.version as number, quote };
}

async function staffPost(page: Page, origin: string, url: string, data: unknown) {
  await page.request.get('/api/auth/csrf');
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === '__Host-bnx_csrf' || c.name === 'bnx_csrf');
  return page.request.post(url, { headers: { origin, 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') }, data });
}

test.describe.serial('storefront checkout', () => {
  test('a contact-bound link shows the store, prices with tax and shipping, and places an order awaiting payment', async ({ page, baseURL }) => {
    const { token, productName, variantId } = fixtures().commerce;
    const origin = new URL(baseURL as string).origin;
    await page.goto(`/shop/${token}`);
    await expect(page.getByText(productName).first()).toBeVisible();
    // Never the contact's profile: the seeded contact's name is not on the page.
    await expect(page.locator('body')).not.toContainText(fixtures().contact.name);

    const { version, quote } = await prepareCheckout(page.request, origin, token, variantId);
    // 499.00 including 18% tax plus 50.00 shipping (taxed the same way).
    expect(quote).toMatchObject({ currency: 'INR', taxInclusive: true, subtotalMinor: 49900, shippingMinor: 5000, totalMinor: 54900 });
    expect(quote.taxMinor).toBe(8375);

    // A total the customer did not see is refused with the new quote, never charged.
    const stale = await page.request.post(shop(token, '/place'), { headers: { origin },
      data: { clientRequestId: crypto.randomUUID(), expectedVersion: version, expectedTotalMinor: quote.totalMinor - 1 } });
    expect(stale.status()).toBeGreaterThanOrEqual(400);
    expect((await stale.json()).code).toBe('quote_changed');

    const clientRequestId = crypto.randomUUID();
    const placed = await page.request.post(shop(token, '/place'), { headers: { origin },
      data: { clientRequestId, expectedVersion: version, expectedTotalMinor: quote.totalMinor } });
    expect(placed.status()).toBe(201);
    const { view } = await placed.json();
    expect(view.order).toMatchObject({ status: 'awaiting_payment', totalMinor: 54900, amountPaidMinor: 0, paidAt: null });
    // A replay returns the same order.
    const replay = await page.request.post(shop(token, '/place'), { headers: { origin },
      data: { clientRequestId, expectedVersion: version, expectedTotalMinor: quote.totalMinor } });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).view.order.reference).toBe(view.order.reference);
  });

  test('a success redirect with Razorpay parameters never marks the order paid', async ({ page }) => {
    const { token } = fixtures().commerce;
    await page.goto(`/shop/${token}/done?razorpay_payment_id=pay_E2EFAKE123&razorpay_payment_link_status=paid&razorpay_signature=x`);
    const status = await page.request.get(shop(token, '/status'));
    expect(status.status()).toBe(200);
    const { order } = await status.json();
    expect(order).toMatchObject({ status: 'awaiting_payment', amountPaidMinor: 0, paidAt: null, documentNumber: null });
  });

  test('the last unit is reserved: a second contact checking out the same product gets out_of_stock', async ({ page, baseURL }) => {
    const { secondToken, variantId } = fixtures().commerce;
    const origin = new URL(baseURL as string).origin;
    const { version, quote } = await prepareCheckout(page.request, origin, secondToken, variantId);
    const placed = await page.request.post(shop(secondToken, '/place'), { headers: { origin },
      data: { clientRequestId: crypto.randomUUID(), expectedVersion: version, expectedTotalMinor: quote.totalMinor } });
    expect(placed.status()).toBeGreaterThanOrEqual(400);
    expect((await placed.json()).code).toBe('out_of_stock');
  });
});

test.describe('staff order journey', () => {
  test('the paid order shows its receipt, and dispatch and delivery are staff-recorded', async ({ page, baseURL }) => {
    const { paidOrderId, receiptNumber } = fixtures().commerce;
    const origin = new URL(baseURL as string).origin;
    await login(page, fixtures().users.owner);
    await page.goto(`/commerce/orders/${paidOrderId}`);
    await expect(page.getByText(receiptNumber).first()).toBeVisible();

    expect((await staffPost(page, origin, `/api/commerce/orders/${paidOrderId}/dispatch`, { from: 'paid', tracking_note: 'E2E courier 42' })).status()).toBe(200);
    expect((await staffPost(page, origin, `/api/commerce/orders/${paidOrderId}/deliver`, { from: 'dispatched' })).status()).toBe(200);
    const timeline = await (await page.request.get(`/api/commerce/orders/${paidOrderId}/events`)).json();
    const moves = timeline.events.filter((e: { kind: string }) => e.kind === 'status_changed')
      .map((e: { to_status: string; actor: string }) => `${e.to_status}:${e.actor}`);
    expect(moves).toEqual(expect.arrayContaining(['dispatched:staff', 'fulfilled:staff']));
    expect(timeline.documents.map((d: { number: string }) => d.number)).toContain(receiptNumber);
  });

  test('another workspace can neither see nor dispatch the order', async ({ page, baseURL }) => {
    const { paidOrderId } = fixtures().commerce;
    const origin = new URL(baseURL as string).origin;
    await login(page, fixtures().outsider);
    expect((await page.request.get(`/api/commerce/orders/${paidOrderId}`)).status()).toBe(404);
    expect((await staffPost(page, origin, `/api/commerce/orders/${paidOrderId}/dispatch`, { from: 'paid' })).status()).not.toBe(200);
  });
});
