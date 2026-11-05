// Phase 15 (design 1.2.5): routes that use the worker database role (no tenant session to lean on).
// A delivery signed with tenant A's secret posted to tenant B's path is refused; a delivery for one
// tenant only ever records receipts and jobs for that tenant; the settings routes as A never read
// or write B's row. Kept in one file under src/test/tenancy because the Razorpay webhook route is
// owned by another task; provider HTTP is stubbed and every other network call fails the test.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest,
  type TenantFixture, type TenantPair,
} from './fixtures';
import { callRoute } from './request-scope';

vi.mock('next/headers', async () => (await import('./request-scope')).nextHeadersMock);

const databases = fixtureDatabaseUrls();
const ZOOM_SECRET = `p15-zoom-${randomBytes(8).toString('hex')}`;
const SHOPIFY_SECRET = `p15-shopify-${randomBytes(8).toString('hex')}`;

type Tenant = TenantFixture & {
  webhookSecret: string; keyId: string; reference: string; trackingToken: string; awb: string;
  wooStoreId: string; wooSecret: string; zoomAccountId: string; shop: string;
};

async function state(accountId: string): Promise<Record<string, unknown>> {
  const pool = fixtureOwnerPool();
  const one = async (sql: string) => (await pool.query(sql, [accountId])).rows;
  return {
    providers: await one("SELECT key_id, mode, key_secret_enc, webhook_secret_enc FROM payment_providers WHERE account_id=$1::uuid"),
    links: await one('SELECT id, status, paid_at FROM payment_links WHERE account_id=$1::uuid ORDER BY id'),
    orders: await one('SELECT id, status, paid_at, amount_paid_minor FROM orders WHERE account_id=$1::uuid ORDER BY id'),
    shipments: await one('SELECT id, tracking_status, awb FROM order_shipments WHERE account_id=$1::uuid ORDER BY id'),
    woo: await one('SELECT id, store_url, webhook_secret_enc FROM woocommerce_stores WHERE account_id=$1::uuid'),
    shopify: await one('SELECT id, shop_domain, uninstalled_at FROM shopify_stores WHERE account_id=$1::uuid'),
    zoom: await one('SELECT id, status FROM meeting_connections WHERE account_id=$1::uuid'),
    jobs: await one('SELECT type, payload FROM jobs WHERE tenant_id=$1::uuid ORDER BY created_at, id'),
    commerce: await one('SELECT count(*)::int AS n FROM commerce_events WHERE account_id=$1::uuid'),
  };
}

async function razorpayReceiptsFor(accountId: string): Promise<number> {
  return (await fixtureOwnerPool().query("SELECT count(*)::int AS n FROM webhook_receipts WHERE provider='razorpay' AND payload->>'accountId'=$1", [accountId])).rows[0].n;
}

async function setUp(t: TenantFixture, tag: string): Promise<Tenant> {
  const pool = fixtureOwnerPool();
  const a = t.accountId;
  const token = randomBytes(24).toString('base64url');
  const wooSecret = `woo-${tag}-${randomBytes(8).toString('hex')}`;
  const reference = `p15${randomUUID().replaceAll('-', '')}`.slice(0, 32);
  await pool.query("INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,order_id,contact_id,status,provider_link_id) VALUES($1,'razorpay',$2,1000,'INR',$3,$4,'created',$5)",
    [a, reference, t.orderId, t.contactId, `plink_p15${tag}${randomBytes(4).toString('hex')}`]);
  const connection = (await pool.query("INSERT INTO courier_connections(account_id,api_email,webhook_token_hash) VALUES($1,$2,$3) RETURNING id",
    [a, `courier-${tag}@example.invalid`, createHash('sha256').update(token).digest('hex')])).rows[0].id;
  const awb = `P15${tag.toUpperCase()}${randomBytes(4).toString('hex')}`;
  await pool.query(`INSERT INTO order_shipments(account_id,order_id,connection_id,reference,create_state,awb,length_cm,breadth_cm,height_cm,weight_grams)
    VALUES($1,$2,$3,$4,'created',$5,10,10,10,500)`, [a, t.orderId, connection, `bx${randomBytes(6).toString('hex')}`, awb]);
  const wooStoreId = (await pool.query('INSERT INTO woocommerce_stores(account_id,store_url,webhook_secret_enc) VALUES($1,$2,$3) RETURNING id',
    [a, `https://shop-${tag}.example.com`, encrypt(wooSecret)])).rows[0].id;
  const zoomAccountId = `p15zoom${tag}${randomBytes(3).toString('hex')}`;
  await pool.query("INSERT INTO meeting_connections(account_id,zoom_account_id,access_token_enc,refresh_token_enc) VALUES($1,$2,$3,$3)",
    [a, zoomAccountId, encrypt('p15-dummy')]);
  const shop = `p15-${tag}-${randomBytes(3).toString('hex')}.myshopify.com`;
  await pool.query('INSERT INTO shopify_stores(account_id,shop_domain,access_token_enc) VALUES($1,$2,$3)', [a, shop, encrypt('p15-dummy')]);
  return { ...t, webhookSecret: `rzp-wh-${tag}-${randomBytes(8).toString('hex')}`, keyId: `rzp_test_P15${tag}${randomBytes(4).toString('hex')}`,
    reference, trackingToken: token, awb, wooStoreId, wooSecret, zoomAccountId, shop };
}

function razorpayEvent(reference: string): string {
  return JSON.stringify({
    entity: 'event', event: 'payment_link.paid', account_id: 'acc_P15test', created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment_link: { entity: { id: `plink_P15${randomBytes(4).toString('hex')}`, reference_id: reference, status: 'paid', amount: 1000, amount_paid: 1000, currency: 'INR' } },
      payment: { entity: { id: `pay_P15${randomBytes(5).toString('hex')}`, amount: 1000, currency: 'INR', status: 'captured' } },
    },
  });
}

describe.skipIf(!databases)('[TEN-01][SEC-03] worker-database routes keep tenants apart', () => {
  let pair: TenantPair;
  let a: Tenant, b: Tenant;
  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.razorpay.com/')) return Response.json({ count: 0, items: [] });
    throw new Error('network disabled in tenancy tests');
  });

  beforeAll(async () => {
    process.env.ZOOM_ENABLED = 'true';
    process.env.ZOOM_CLIENT_ID = 'p15-client';
    process.env.ZOOM_CLIENT_SECRET = 'p15-client-secret';
    process.env.ZOOM_WEBHOOK_SECRET_TOKEN = ZOOM_SECRET;
    process.env.SHOPIFY_API_KEY = 'p15-shopify-key';
    process.env.SHOPIFY_API_SECRET = SHOPIFY_SECRET;
    delete process.env.SHIPROCKET_DISABLED;
    vi.stubGlobal('fetch', fetchSpy);
    pair = await createTenantPair({ label: 'workerdb' });
    a = await setUp(pair.a, 'a');
    b = await setUp(pair.b, 'b');
    // Each tenant connects Razorpay through the real settings route as its own admin.
    const settings = await import('@/app/api/payments/razorpay/settings/route');
    for (const t of [a, b]) {
      const response = await callRoute(settings.PUT, await signedRequest(t.users.admin, 'PUT', '/api/payments/razorpay/settings',
        { key_id: t.keyId, key_secret: `secret-${randomBytes(8).toString('hex')}`, webhook_secret: t.webhookSecret }));
      expect(response.status).toBe(200);
    }
  }, 120000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('payments/razorpay/settings: A reads and changes only its own connection', async () => {
    const settings = await import('@/app/api/payments/razorpay/settings/route');
    const beforeB = await state(b.accountId);
    const read = await callRoute(settings.GET, await signedRequest(a.users.viewer, 'GET', '/api/payments/razorpay/settings'));
    const body = await read.json();
    expect(body).toMatchObject({ connected: true, key_id: a.keyId, webhook_secret_set: true });
    expect(body.webhook_url).toContain(a.accountId);
    expect(JSON.stringify(body)).not.toContain(b.accountId);
    expect(JSON.stringify(body)).not.toContain(a.webhookSecret);
    const replaced = await callRoute(settings.PUT, await signedRequest(a.users.admin, 'PUT', '/api/payments/razorpay/settings',
      { key_id: a.keyId, key_secret: `secret-${randomBytes(8).toString('hex')}` }));
    expect(replaced.status).toBe(200);
    expect(await state(b.accountId)).toEqual(beforeB);
  }, 60000);

  it("payments/razorpay/webhook/[accountId]: A's signature on B's path is refused; B's own delivery stays in B", async () => {
    const { POST } = await import('@/app/api/payments/razorpay/webhook/[accountId]/route');
    const beforeA = await state(a.accountId), beforeB = await state(b.accountId);
    const post = (accountId: string, raw: string, secret: string) => POST(new Request(`https://crm.tenancy.test/api/payments/razorpay/webhook/${accountId}`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-razorpay-event-id': `evt_${randomBytes(6).toString('hex')}` },
    }), { params: Promise.resolve({ accountId }) });
    // A's secret, B's path, B's own link reference.
    expect((await post(b.accountId, razorpayEvent(b.reference), a.webhookSecret)).status).toBe(401);
    expect(await state(b.accountId)).toEqual(beforeB);
    expect(await razorpayReceiptsFor(b.accountId)).toBe(0);
    // B's secret on B's path naming A's link: recorded and queued for B only, A untouched.
    expect((await post(b.accountId, razorpayEvent(a.reference), b.webhookSecret)).status).toBe(200);
    const jobs = (await state(b.accountId)).jobs as { type: string }[];
    expect(jobs.length).toBe((beforeB.jobs as unknown[]).length + 1);
    expect(await state(a.accountId)).toEqual(beforeA);
    expect(await razorpayReceiptsFor(a.accountId)).toBe(0);
    expect(await razorpayReceiptsFor(b.accountId)).toBe(1);
  }, 60000);

  it("fulfilment/tracking/[accountId]: A's token on B's path is refused; B's AWB pushed to A's path is ignored", async () => {
    const { POST } = await import('@/app/api/fulfilment/tracking/[accountId]/route');
    const beforeA = await state(a.accountId), beforeB = await state(b.accountId);
    const post = (accountId: string, token: string, awb: string) => POST(new Request(`https://crm.tenancy.test/api/fulfilment/tracking/${accountId}`, {
      method: 'POST', body: JSON.stringify({ awb, current_status: 'IN TRANSIT', current_status_id: 18, shipment_status_id: 18, current_timestamp: '2026-11-05 10:00:00' }),
      headers: { 'content-type': 'application/json', 'x-api-key': token, 'x-forwarded-for': '198.51.100.7' },
    }), { params: Promise.resolve({ accountId }) });
    expect((await post(b.accountId, a.trackingToken, b.awb)).status).toBe(401);
    expect((await post(a.accountId, a.trackingToken, b.awb)).status).toBe(200);
    expect(await state(a.accountId)).toEqual(beforeA);
    expect(await state(b.accountId)).toEqual(beforeB);
    // Positive control: A's own AWB on A's path queues one re-fetch job for A.
    expect((await post(a.accountId, a.trackingToken, a.awb)).status).toBe(200);
    expect(((await state(a.accountId)).jobs as unknown[]).length).toBe((beforeA.jobs as unknown[]).length + 1);
    expect(await state(b.accountId)).toEqual(beforeB);
  }, 60000);

  it("integrations/woocommerce/webhook/[storeId]: A's secret on B's store is refused", async () => {
    const { POST } = await import('@/app/api/integrations/woocommerce/webhook/[storeId]/route');
    const beforeA = await state(a.accountId), beforeB = await state(b.accountId);
    const raw = JSON.stringify({ id: 9001, number: '9001', status: 'processing', currency: 'INR', total: '10.00', billing: { phone: '+910000000006', first_name: 'P15' }, line_items: [] });
    const response = await POST(new Request(`https://crm.tenancy.test/api/integrations/woocommerce/webhook/${b.wooStoreId}`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': randomUUID(),
        'x-wc-webhook-signature': createHmac('sha256', a.wooSecret).update(raw).digest('base64') },
    }), { params: Promise.resolve({ storeId: b.wooStoreId }) });
    expect(response.status).toBe(401);
    expect(await state(a.accountId)).toEqual(beforeA);
    expect(await state(b.accountId)).toEqual(beforeB);
  }, 60000);

  it('integrations/woocommerce: the settings route as A lists only its own store', async () => {
    const route = await import('@/app/api/integrations/woocommerce/route');
    const response = await callRoute(route.GET, await signedRequest(a.users.admin, 'GET', '/api/integrations/woocommerce'));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(b.wooStoreId);
    expect(text).not.toContain('shop-b.example.com');
    expect(text).not.toContain(a.wooSecret);
  }, 30000);

  it("integrations/zoom/webhook: an event for A's Zoom account is queued for A only, whatever ids it carries", async () => {
    const { POST } = await import('@/app/api/integrations/zoom/webhook/route');
    const beforeB = await state(b.accountId);
    const jobsA = ((await state(a.accountId)).jobs as unknown[]).length;
    const raw = JSON.stringify({ event: 'meeting.started', event_ts: Date.now(),
      payload: { account_id: a.zoomAccountId, object: { id: '81234567890', host_id: b.zoomAccountId, uuid: b.accountId } } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await POST(new Request('https://crm.tenancy.test/api/integrations/zoom/webhook', {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': timestamp,
        'x-zm-signature': `v0=${createHmac('sha256', ZOOM_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex')}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'queued' });
    const after = (await state(a.accountId)).jobs as { payload: { connectionId?: string } }[];
    expect(after.length).toBe(jobsA + 1);
    const zoomA = (await fixtureOwnerPool().query('SELECT id FROM meeting_connections WHERE account_id=$1', [a.accountId])).rows[0].id;
    expect(after.at(-1)?.payload.connectionId).toBe(zoomA);
    expect(await state(b.accountId)).toEqual(beforeB);
    // The settings route as A never shows B's connection.
    const settings = await import('@/app/api/integrations/zoom/route');
    const text = await (await callRoute(settings.GET, await signedRequest(a.users.admin, 'GET', '/api/integrations/zoom'))).text();
    expect(text).not.toContain(b.zoomAccountId);
  }, 60000);

  it("integrations/shopify/webhooks: app/uninstalled for A's shop stops only A's store", async () => {
    const { POST } = await import('@/app/api/integrations/shopify/webhooks/route');
    const beforeB = await state(b.accountId);
    const raw = JSON.stringify({ id: 1, domain: a.shop, myshopify_domain: a.shop });
    const response = await POST(new Request('https://crm.tenancy.test/api/integrations/shopify/webhooks', {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': a.shop,
        'x-shopify-webhook-id': randomUUID(), 'x-shopify-triggered-at': new Date().toISOString(),
        'x-shopify-hmac-sha256': createHmac('sha256', SHOPIFY_SECRET).update(raw).digest('base64') },
    }));
    expect(response.status).toBe(200);
    const storeA = (await state(a.accountId)).shopify as { uninstalled_at: string | null }[];
    expect(storeA[0].uninstalled_at).not.toBeNull();
    expect(await state(b.accountId)).toEqual(beforeB);
    const settings = await import('@/app/api/integrations/shopify/route');
    const text = await (await callRoute(settings.GET, await signedRequest(a.users.admin, 'GET', '/api/integrations/shopify'))).text();
    expect(text).not.toContain(b.shop);
  }, 60000);
});
