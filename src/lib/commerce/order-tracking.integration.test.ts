import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { POST as delivery } from '@/app/api/public/store/[handle]/delivery/route';
import { loadOrderTracking, orderTrackingLink } from './order-tracking';
import { orderTrackingToken } from './order-tracking-token';
import { loadOrderView } from './storefront';

// Store Phase 5 on PostgreSQL: the public tracking page opens only for its own shop with a genuine token, shows
// no phone number, street address or internal id, and the pincode check prices from that workspace's own rates only.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
const ORIGIN = new URL(process.env.APP_URL).origin;

const A = randomUUID(), B = randomUUID(), owner = randomUUID();
const contact = randomUUID(), order = randomUUID(), orderB = randomUUID(), conn = randomUUID(), shipment = randomUUID();
const product = randomUUID(), variant = randomUUID(), productB = randomUUID(), variantB = randomUUID();
const handleA = `p5a-${A.slice(0, 8)}`, handleB = `p5b-${B.slice(0, 8)}`;
const PHONE = '919876543210', STREET = '14 Secret Lane', NOTE = 'internal-note-xyz';
let db: pg.Client;
let ip = 0;

const post = (handle: string, body: unknown, origin: string | null = ORIGIN) => delivery(new Request(`${ORIGIN}/api/public/store/${handle}/delivery`, {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': `198.51.100.${(ip++ % 200) + 1}` },
}), { params: Promise.resolve({ handle }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('order tracking and pincode check on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'P5 track','test-only-hash')", [owner, `${owner}@example.invalid`]);
    for (const [id, name, handle, cod] of [[A, 'Track A', handleA, true], [B, 'Track B', handleB, true]] as const) {
      await db.query('INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3)', [id, name, owner]);
      await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [id]);
      await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
      await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,cod_enabled)
        VALUES($1,'INR',true,0,true,$2)`, [id, cod]);
      await db.query("INSERT INTO shop_storefronts(account_id,handle,published,template) VALUES($1,$2,true,'wellness')", [id, handle]);
    }
    // A ships to 560xxx for 49.00 (COD fine) and 110xxx for 80.00 (no COD); B ships everywhere for 1.00.
    await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor,postal_prefixes,cod_allowed) VALUES
      ($1,'Bengaluru','IN',4900,'{560}',true),($1,'Delhi','IN',8000,'{110}',false),($2,'B everywhere','IN',100,'{}',true)`, [A, B]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Private Buyer',$4)", [contact, A, owner, PHONE]);
    await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
        status,priced_at,payment_method,note,shipping_address,dispatched_at)
      VALUES($1,$2,'storefront',$3,'INR',20000,0,4900,0,true,24900,'dispatched',now(),'online',$4,$5::jsonb,now())`,
    [order, A, contact, NOTE, JSON.stringify({ name: 'Private Buyer', phone: `+${PHONE}`, line1: STREET, city: 'Bengaluru', postal_code: '560001', country: 'IN' })]);
    await db.query(`INSERT INTO orders(id,account_id,source,currency,subtotal_minor,total_minor,status) VALUES($1,$2,'manual','INR',100,100,'new')`, [orderB, B]);
    await db.query("INSERT INTO order_items(account_id,order_id,name,quantity,unit_price_minor,currency,sku) VALUES($1,$2,'Triphala powder',2,10000,'INR','TRI-SECRET-SKU')", [A, order]);
    await db.query(`INSERT INTO courier_connections(id,account_id,api_email,api_password_enc,token_enc,webhook_token_hash)
      VALUES($1,$2,'api@example.invalid','enc-p','enc-t',repeat('a',64))`, [conn, A]);
    await db.query(`INSERT INTO order_shipments(id,account_id,order_id,connection_id,reference,claim_token,create_state,awb,courier_name,tracking_status,
        length_cm,breadth_cm,height_cm,weight_grams) VALUES($1,$2,$3,$4,'bxtrack0000001',gen_random_uuid(),'created','AWB12345','Delhivery','out_for_delivery',10,10,10,500)`,
    [shipment, A, order, conn]);
    await db.query("INSERT INTO shipment_tracking_events(account_id,shipment_id,status,provider_code,event_at,source) VALUES($1,$2,'out_for_delivery','17','2026-11-04T06:00:00Z','poll')", [A, shipment]);
    await db.query("INSERT INTO shop_products(id,account_id,name,status,content_reviewed_at,cod_available) VALUES($1,$2,'Oil','published',now(),true),($3,$4,'Other','published',now(),true)", [product, A, productB, B]);
    await db.query("INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor,weight_grams) VALUES($1,$2,$3,'OIL-1',10000,400),($4,$5,$6,'B-1',500,100)", [variant, A, product, variantB, B, productB]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('shows the order, timeline and courier to the genuine link', async () => {
    const view = await loadOrderTracking(handleA, orderTrackingToken(A, order));
    expect(view).toMatchObject({
      status: 'dispatched', totalMinor: 24900, items: [{ name: 'Triphala powder', quantity: 2 }],
      deliveryTo: { city: 'Bengaluru', postalCode: '560001' },
      shipment: { courierName: 'Delhivery', awb: 'AWB12345', trackingUrl: 'https://shiprocket.co/tracking/AWB12345' },
    });
    expect(view!.timeline.map((s) => `${s.key}:${s.state}`)).toEqual([
      'placed:done', 'confirmed:done', 'shipped:done', 'out_for_delivery:current', 'delivered:upcoming',
    ]);
    expect(view!.timeline[3].at).toBe('2026-11-04T06:00:00.000Z');
  });

  it('never carries the phone number, street, note, SKU, contact name or an internal id', async () => {
    const text = JSON.stringify(await loadOrderTracking(handleA, orderTrackingToken(A, order)));
    for (const secret of [PHONE, STREET, NOTE, 'TRI-SECRET-SKU', 'Private Buyer', order, A, contact, shipment, conn]) expect(text).not.toContain(secret);
  });

  it('is a 404 for a wrong token, another shop, another shop order and an unknown handle', async () => {
    const token = orderTrackingToken(A, order);
    expect(await loadOrderTracking(handleB, token)).toBeNull();
    expect(await loadOrderTracking('no-such-shop', token)).toBeNull();
    expect(await loadOrderTracking(handleA, `${token.slice(0, 63)}${token.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await loadOrderTracking(handleA, 'garbage')).toBeNull();
    // B's genuine token never opens on A's handle, and a token for an order that does not exist is empty.
    expect(await loadOrderTracking(handleA, orderTrackingToken(B, orderB))).toBeNull();
    expect(await loadOrderTracking(handleB, orderTrackingToken(B, order))).toBeNull();
    expect(await loadOrderTracking(handleA, orderTrackingToken(A, randomUUID()))).toBeNull();
    expect((await loadOrderTracking(handleB, orderTrackingToken(B, orderB)))?.status).toBe('new');
  });

  it('hands the link to the buyer on the order page and in messages', async () => {
    const path = `/s/${handleA}/track/${orderTrackingToken(A, order)}`;
    const view = await withTenant({ accountId: A, role: 'owner' }, (tx) => loadOrderView(tx, A, order), getWorkerPrisma());
    expect(view?.trackingPath).toBe(path);
    expect(await orderTrackingLink(A, order)).toBe(`${ORIGIN}${path}`);
    await db.query('UPDATE shop_storefronts SET published=false WHERE account_id=$1', [A]);
    expect(await orderTrackingLink(A, order)).toBe('');
    expect(await loadOrderTracking(handleA, orderTrackingToken(A, order))).toBeNull();
    await db.query('UPDATE shop_storefronts SET published=true WHERE account_id=$1', [A]);
  });

  it('answers the pincode check from this workspace own rates and COD switches', async () => {
    const ok = await post(handleA, { variantId: variant, pincode: '560001' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deliverable: true, unknown: false, shippingMinor: 4900, currency: 'INR', cod: true });
    // A zone that refuses COD.
    expect(await (await post(handleA, { variantId: variant, pincode: '110001' })).json()).toMatchObject({ deliverable: true, shippingMinor: 8000, cod: false });
    // Outside A's zones: not deliverable, never priced by B's cheap rate.
    expect(await (await post(handleA, { variantId: variant, pincode: '400001' })).json()).toMatchObject({ deliverable: false, unknown: false, cod: false });
    // The product turns COD off, then the store does.
    await db.query('UPDATE shop_products SET cod_available=false WHERE id=$1', [product]);
    expect((await (await post(handleA, { variantId: variant, pincode: '560001' })).json()).cod).toBe(false);
    await db.query('UPDATE shop_products SET cod_available=true WHERE id=$1', [product]);
    await db.query('UPDATE commerce_settings SET cod_enabled=false WHERE account_id=$1', [A]);
    expect((await (await post(handleA, { variantId: variant, pincode: '560001' })).json()).cod).toBe(false);
    await db.query('UPDATE commerce_settings SET cod_enabled=true WHERE account_id=$1', [A]);
    // A state-only zone makes an unmatched pincode "unknown" (checkout decides), not "no".
    await db.query("INSERT INTO shipping_rates(account_id,name,country,fee_minor,states) VALUES($1,'Maharashtra','IN',6000,'{MH}')", [A]);
    expect(await (await post(handleA, { variantId: variant, pincode: '400001' })).json()).toMatchObject({ deliverable: false, unknown: true });
    expect(await (await post(handleA, { variantId: variant, pincode: '560001' })).json()).toMatchObject({ deliverable: true, unknown: false });
    await db.query("DELETE FROM shipping_rates WHERE account_id=$1 AND name='Maharashtra'", [A]);
    // B's own shop uses B's rate.
    expect(await (await post(handleB, { variantId: variantB, pincode: '560001' })).json()).toMatchObject({ deliverable: true, shippingMinor: 100 });
  });

  it('refuses a variant of another shop, a bad pincode, a bad body and a bad Origin', async () => {
    expect((await post(handleA, { variantId: variantB, pincode: '560001' })).status).toBe(404);
    expect((await post(handleA, { variantId: variant, pincode: '56001' })).status).toBe(404);
    expect((await post(handleA, { variantId: 'nope', pincode: '560001' })).status).toBe(404);
    expect((await post(handleA, 'not an object')).status).toBe(400);
    expect((await post('no-such-shop', { variantId: variant, pincode: '560001' })).status).toBe(404);
    for (const origin of ['https://evil.example', null]) {
      const res = await post(handleA, { variantId: variant, pincode: '560001' }, origin);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.json()).not.toHaveProperty('deliverable');
    }
  });
});
