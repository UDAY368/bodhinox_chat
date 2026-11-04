import { createHash, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import type { FulfilmentActor } from './types';

// Phase 9 T4 on PostgreSQL: the Shiprocket connection, shipment creation and
// the sweep. Shiprocket is the only fake (global fetch, behind leaseFetch):
// rows, RLS, grants, claims, jobs and audit rows are real. The gate: a
// shipment is never created twice and an AWB is never assigned twice after an
// ambiguous outcome; nothing calls Shiprocket while a workspace is not
// connected or the deployment switched it off.
const tracked = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock('./tracking-job', () => ({ enqueueShipmentTrack: tracked.enqueue, handleShipmentTrackJob: vi.fn() }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), accountC = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID(), ownerC = randomUUID();
const users = [ownerA, adminA, agentA, ownerB, ownerC];
const asAdmin: FulfilmentActor = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: FulfilmentActor = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: FulfilmentActor = { accountId: accountB, userId: ownerB, role: 'owner' };
const asC: FulfilmentActor = { accountId: accountC, userId: ownerC, role: 'owner' };
const contactA = randomUUID();
const DIMS = { length_cm: 20, breadth_cm: 15, height_cm: 10, weight_grams: 750 };
const ADDRESS = { name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: 'KA', postal_code: '560001', country: 'IN', instructions: null };
const META = { attempts: 1, maxAttempts: 5 };
const FINAL = { attempts: 5, maxAttempts: 5 };

type Reply = Response | Error | ((body: unknown) => Response | Error);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();
const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
let routes: Record<string, Reply[]> = {};
let srCounter = 7000;
let awbCounter = 100;

function defaultReply(path: string): Response {
  if (path === '/auth/login') return json({ token: 'test-token-abcdefghijklmnop' });
  if (path === '/settings/company/pickup') return json({ data: { shipping_address: [{ pickup_location: 'Primary' }, { pickup_location: 'Warehouse 2' }] } });
  if (path === '/orders/create/adhoc') { srCounter += 2; return json({ order_id: srCounter, shipment_id: srCounter + 1, status: 'NEW' }); }
  if (path === '/courier/assign/awb') { awbCounter += 1; return json({ awb_assign_status: 1, response: { data: { awb_code: `AWB${awbCounter}`, courier_name: 'Delhivery' } } }); }
  if (path === '/courier/generate/pickup') return json({ pickup_status: 1 });
  if (path === '/orders/cancel') return json({ message: 'cancelled' });
  if (path === '/courier/generate/label') return json({ label_created: 1, label_url: 'https://kr-labels.example/label.pdf' });
  if (path.startsWith('/orders?search=')) return json({ data: [] });
  if (path.startsWith('/orders/show/')) return json({ data: {} });
  return json({ message: 'unexpected' }, 404);
}

const pathsCalled = (path: string) => calls.filter((c) => c.path === path || c.path.startsWith(path));

let db: pg.Client;
const one = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

async function paidOrder(account = accountA, overrides: { status?: string; currency?: string; address?: unknown } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,shipping_address) VALUES($1,$2,'storefront',$3,$4,49800,5000,0,true,54800,$5,now(),now(),54800,$6)`,
  [id, account, account === accountA ? contactA : null, overrides.currency ?? 'INR', overrides.status ?? 'paid',
    JSON.stringify(overrides.address === undefined ? ADDRESS : overrides.address)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,hsn_code,quantity,unit_price_minor,currency,tax_rate_bps)
    VALUES($1,$2,'Triphala churna','TRI-100','3004',2,24900,$3,1200)`, [account, id, overrides.currency ?? 'INR']);
  return id;
}

const shipmentOf = (orderId: string) => one(`SELECT id, reference, create_state, awb_state, claim_token, sr_order_id, sr_shipment_id, awb,
  courier_name, tracking_status, last_error_code FROM order_shipments WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [orderId]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Shiprocket shipments on PostgreSQL', { timeout: 120_000 }, () => {
  let mod: typeof import('./shipments');
  let conn: typeof import('./connection');
  let sweep: typeof import('./sweep');

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 T4', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ship A',$2),($3,'Ship B',$4),($5,'Ship C',$6)",
      [accountA, ownerA, accountB, ownerB, accountC, ownerC]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'free')", [accountC]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner'),($7,$8,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB, accountC, ownerC]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone,email) VALUES($1,$2,$3,'Asha','919876543210','asha@example.invalid')",
      [contactA, accountA, ownerA]);
    vi.stubGlobal('fetch', fetchMock);
    mod = await import('./shipments');
    conn = await import('./connection');
    sweep = await import('./sweep');
  });

  beforeEach(() => {
    calls.length = 0;
    routes = {};
    tracked.enqueue.mockClear();
    delete process.env.SHIPROCKET_DISABLED;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://apiv2.shiprocket.in');
      const path = url.pathname.replace('/v1/external', '') + url.search;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      calls.push({ method: init?.method ?? 'GET', path, body, auth });
      const key = Object.keys(routes).find((k) => path === k || path.startsWith(k));
      const queued = key ? routes[key].shift() : undefined;
      const reply = typeof queued === 'function' ? queued(body) : queued;
      if (reply instanceof Error) throw reply;
      return reply ?? defaultReply(path);
    });
  });

  afterEach(() => { delete process.env.SHIPROCKET_DISABLED; });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB, accountC]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('refuses everything without a connection and makes no Shiprocket call', async () => {
    const order = await paidOrder(accountB);
    await expect(mod.requestShipment(asB, order, DIMS)).rejects.toMatchObject({ code: 'not_connected', status: 503 });
    await expect(conn.rotateWebhookToken(asB)).rejects.toMatchObject({ code: 'not_connected' });
    expect(await conn.courierWebhookTokenMatches(accountB, 'x'.repeat(43))).toBe(false);
    expect(await withTenant(asB, (tx) => conn.getCourierConnection(tx, accountB))).toMatchObject({ connected: false, webhook_url: null });
    process.env.SHIPROCKET_DISABLED = 'true';
    await expect(conn.saveCourierConnection(asB, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Primary', defaults: {} }))
      .rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    // A plan without courier shipping cannot connect.
    delete process.env.SHIPROCKET_DISABLED;
    const free = await one("SELECT (features->>'courier_shipping')::boolean AS on FROM plans WHERE id='free'");
    if (free?.on === false) {
      await expect(conn.saveCourierConnection(asC, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Primary', defaults: {} }))
        .rejects.toMatchObject({ status: 402 });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('connects only after Shiprocket accepts the API user, keeping every secret from the app role', async () => {
    await expect(conn.saveCourierConnection(asAgent, { email: 'api@example.invalid', password: 'p', pickup_location: 'Primary', defaults: {} }))
      .rejects.toMatchObject({ status: 403 });
    routes['/auth/login'] = [json({ message: 'Invalid email and password combination' }, 400)];
    await expect(conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: 'wrong', pickup_location: 'Primary', defaults: {} }))
      .rejects.toMatchObject({ code: 'auth', status: 400 });
    routes['/auth/login'] = [new TypeError('network down')];
    await expect(conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Primary', defaults: {} }))
      .rejects.toMatchObject({ code: 'provider_unreachable', status: 502 });
    await expect(conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Elsewhere', defaults: {} }))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(await one('SELECT count(*)::int AS n FROM courier_connections WHERE account_id=$1', [accountA])).toEqual({ n: 0 });

    const dto = await conn.saveCourierConnection(asAdmin, {
      email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Primary', defaults: { length_cm: 20, weight_grams: 500 },
    });
    expect(dto).toMatchObject({ connected: true, status: 'active', api_email: 'api@example.invalid', pickup_location: 'Primary',
      default_length_cm: 20, default_weight_grams: 500, webhook_token_set: false });
    expect(dto.webhook_url).toMatch(new RegExp(`/api/fulfilment/tracking/${accountA}$`));
    expect(JSON.stringify(dto)).not.toMatch(/secret-pass|test-token/);
    const row = await one('SELECT api_password_enc, token_enc FROM courier_connections WHERE account_id=$1', [accountA]);
    expect(row.api_password_enc).not.toContain('secret-pass');
    expect(row.token_enc).not.toContain('test-token');
    await expect(withTenant(asAdmin, (tx) => tx.$queryRawUnsafe('SELECT api_password_enc FROM courier_connections'))).rejects.toThrow();
    expect(await one(`SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='integrations.shiprocket_connect'`, [accountA]))
      .toEqual({ n: 1 });

    // A blank password keeps the stored one (same API user); the pickup list uses the stored details.
    calls.length = 0;
    expect(await conn.listPickupLocations(asAdmin)).toEqual(['Primary', 'Warehouse 2']);
    expect(calls[0]).toMatchObject({ path: '/auth/login', body: { email: 'api@example.invalid', password: 'secret-pass' } });
    const updated = await conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: '', pickup_location: 'Warehouse 2', defaults: DIMS });
    expect(updated).toMatchObject({ pickup_location: 'Warehouse 2', default_height_cm: 10 });
    await expect(conn.saveCourierConnection(asAdmin, { email: 'other@example.invalid', password: '', pickup_location: 'Primary', defaults: {} }))
      .rejects.toMatchObject({ code: 'auth' });
  });

  it('stores only the digest of the webhook token and compares it per workspace', async () => {
    const { token } = await conn.rotateWebhookToken(asAdmin);
    const stored = await one('SELECT webhook_token_hash FROM courier_connections WHERE account_id=$1 AND status<>$2', [accountA, 'disconnected']);
    expect(stored.webhook_token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(await conn.courierWebhookTokenMatches(accountA, token)).toBe(true);
    expect(await conn.courierWebhookTokenMatches(accountA, `${token}x`)).toBe(false);
    expect(await conn.courierWebhookTokenMatches(accountB, token)).toBe(false);
    const { token: next } = await conn.rotateWebhookToken(asAdmin);
    expect(await conn.courierWebhookTokenMatches(accountA, token)).toBe(false);
    expect(await conn.courierWebhookTokenMatches(accountA, next)).toBe(true);
    expect((await withTenant(asAgent, (tx) => conn.getCourierConnection(tx, accountA))).webhook_token_set).toBe(true);
  });

  it('refuses unpaid, refunding, duplicate and unshippable orders before any call', async () => {
    calls.length = 0;
    const unpaid = await paidOrder(accountA, { status: 'awaiting_payment' });
    await expect(mod.requestShipment(asAdmin, unpaid, DIMS)).rejects.toMatchObject({ code: 'order_not_paid', status: 409 });
    const usd = await paidOrder(accountA, { currency: 'USD' });
    await expect(mod.requestShipment(asAdmin, usd, DIMS)).rejects.toMatchObject({ code: 'address_incomplete' });
    const abroad = await paidOrder(accountA, { address: { ...ADDRESS, country: 'US' } });
    await expect(mod.requestShipment(asAdmin, abroad, DIMS)).rejects.toMatchObject({ code: 'address_incomplete' });
    const noState = await paidOrder(accountA, { address: { ...ADDRESS, state: null } });
    await expect(mod.requestShipment(asAdmin, noState, DIMS)).rejects.toMatchObject({ code: 'address_incomplete' });
    await expect(mod.requestShipment(asAdmin, noState, { ...DIMS, weight_grams: 0 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(mod.requestShipment(asAgent, noState, DIMS)).rejects.toMatchObject({ status: 403 });

    const refunding = await paidOrder();
    const payment = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,order_id,amount_minor,currency,status,captured_at,settlement)
      VALUES($1,$2,'razorpay',$3,$4,54800,'INR','captured',now(),'settled')`, [payment, accountA, `pay_${payment.slice(0, 8)}`, refunding]);
    await db.query(`INSERT INTO customer_refunds(account_id,payment_id,order_id,source,amount_minor,currency,reason_code,status,restock)
      VALUES($1,$2,$3,'bodhinox',54800,'INR','cancelled','unknown',true)`, [accountA, payment, refunding]);
    await expect(mod.requestShipment(asAdmin, refunding, DIMS)).rejects.toMatchObject({ code: 'refund_in_flight' });

    const twice = await paidOrder();
    await mod.requestShipment(asAdmin, twice, DIMS);
    await expect(mod.requestShipment(asAdmin, twice, DIMS)).rejects.toMatchObject({ code: 'shipment_exists' });
    expect(calls).toEqual([]);
  });

  it('creates once, assigns once and records the AWB; a replayed job calls nothing', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    const queued = await one('SELECT type, payload FROM jobs WHERE dedupe_key=$1', [`shpcreate:${shipmentId}`]);
    expect(queued).toEqual({ type: 'commerce.create_shipment', payload: { shipmentId } });
    expect(await one(`SELECT actor, actor_user_id FROM order_events WHERE order_id=$1 AND kind='shipment_created'`, [order]))
      .toEqual({ actor: 'staff', actor_user_id: adminA });
    expect(await one(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id=$1 AND action='commerce.shipment_create'`, [shipmentId])).toEqual({ n: 1 });

    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    const create = pathsCalled('/orders/create/adhoc');
    expect(create).toHaveLength(1);
    const ship = await shipmentOf(order);
    expect(create[0].body).toMatchObject({
      order_id: ship.reference, pickup_location: 'Warehouse 2', billing_pincode: '560001', billing_state: 'Karnataka',
      billing_phone: '9876543210', billing_email: 'asha@example.invalid', payment_method: 'Prepaid', weight: 0.75, length: 20,
      sub_total: 498, shipping_charges: 50,
      order_items: [{ name: 'Triphala churna', sku: 'TRI-100', units: 2, selling_price: 249, tax: 12, hsn: '3004' }],
    });
    expect(create[0].auth).toBe('Bearer test-token-abcdefghijklmnop');
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(1);
    expect(pathsCalled('/courier/generate/pickup')).toHaveLength(1);
    expect(ship).toMatchObject({ create_state: 'created', awb_state: 'assigned', claim_token: null, courier_name: 'Delhivery',
      tracking_status: 'awb_assigned' });
    expect(ship.awb).toMatch(/^AWB\d+$/);
    expect(await one('SELECT status, source FROM shipment_tracking_events WHERE shipment_id=$1', [shipmentId]))
      .toEqual({ status: 'awb_assigned', source: 'create' });

    calls.length = 0;
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(calls).toEqual([]);
    // The app sees the shipment without the claim token; a cached token avoided a second login.
    const view = await withTenant(asAgent, (tx) => mod.getOrderShipment(tx, accountA, order));
    expect(view).toMatchObject({ id: shipmentId, awb_state: 'assigned', weight_grams: 750 });
    expect(view).not.toHaveProperty('claim_token');
    expect(await mod.labelUrl(asAdmin, order)).toBe('https://kr-labels.example/label.pdf');
  });

  it('reconciles an ambiguous create by reference and never posts it again', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/orders/create/adhoc'] = [new TypeError('socket hang up')];
    await expect(mod.handleCreateShipmentJob(accountA, { shipmentId }, META)).rejects.toThrow('shipment_outcome_unknown');
    expect((await shipmentOf(order)).create_state).toBe('unknown');
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(1);

    const { reference } = await shipmentOf(order);
    routes['/orders?search='] = [json({ data: [{ id: 99001, channel_order_id: `${reference}x`, shipments: [{ id: 1 }] },
      { id: 88123, channel_order_id: reference, shipments: [{ id: 88124, awb: null }] }] })];
    calls.length = 0;
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
    expect(pathsCalled('/orders?search=')[0].path).toBe(`/orders?search=${reference}`);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'created', sr_order_id: '88123', sr_shipment_id: '88124', awb_state: 'assigned' });
    expect(pathsCalled('/courier/assign/awb')[0].body).toEqual({ shipment_id: 88124 });
  });

  it('opens create_unknown on the final attempt when the order cannot be found', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/orders/create/adhoc'] = [json({ message: 'upstream' }, 502)];
    await expect(mod.handleCreateShipmentJob(accountA, { shipmentId }, META)).rejects.toThrow();
    calls.length = 0;
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, FINAL);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
    expect((await shipmentOf(order)).create_state).toBe('unknown');
    expect(await one(`SELECT kind, status FROM shipment_exceptions WHERE shipment_id=$1`, [shipmentId])).toEqual({ kind: 'create_unknown', status: 'open' });
    // The live unknown shipment still blocks a second one.
    await expect(mod.requestShipment(asAdmin, order, DIMS)).rejects.toMatchObject({ code: 'shipment_exists' });
  });

  it('never assigns an AWB again after an ambiguous assignment: adopts it or opens awb_unknown', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/courier/assign/awb'] = [new TypeError('timeout')];
    await expect(mod.handleCreateShipmentJob(accountA, { shipmentId }, META)).rejects.toThrow();
    const ship = await shipmentOf(order);
    expect(ship).toMatchObject({ create_state: 'created', awb_state: 'unknown' });

    routes['/orders/show/'] = [json({ data: { id: Number(ship.sr_order_id), shipments: { id: Number(ship.sr_shipment_id), awb: '' } } })];
    calls.length = 0;
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, FINAL);
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(0);
    expect(pathsCalled('/orders/show/')[0].path).toBe(`/orders/show/${ship.sr_order_id}`);
    expect(await one(`SELECT kind FROM shipment_exceptions WHERE shipment_id=$1 AND status='open'`, [shipmentId])).toEqual({ kind: 'awb_unknown' });
    // "Assign courier again" is refused for an unknown assignment.
    await expect(mod.reassignAwb(asAdmin, order)).rejects.toMatchObject({ code: 'conflict' });

    // The sweep finds the AWB later and adopts it; still no second assignment.
    routes['/orders/show/'] = [json({ data: { id: Number(ship.sr_order_id), shipments: { id: Number(ship.sr_shipment_id), awb: 'SRX12345', courier: 'Bluedart' } } })];
    calls.length = 0;
    expect(await mod.reconcileShipment(accountA, shipmentId)).toBe('adopted');
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(0);
    expect(await shipmentOf(order)).toMatchObject({ awb_state: 'assigned', awb: 'SRX12345', courier_name: 'Bluedart' });
  });

  it('lets staff assign again only after a definite refusal', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/courier/assign/awb'] = [json({ message: 'Insufficient wallet balance, please recharge' }, 400)];
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(await shipmentOf(order)).toMatchObject({ awb_state: 'failed', last_error_code: 'insufficient_balance' });
    await expect(mod.reassignAwb(asAgent, order)).rejects.toMatchObject({ status: 403 });
    await mod.reassignAwb(asAdmin, order);
    expect(await one(`SELECT status, attempts FROM jobs WHERE dedupe_key=$1`, [`shpcreate:${shipmentId}`])).toEqual({ status: 'pending', attempts: 0 });
    calls.length = 0;
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(1);
    expect((await shipmentOf(order)).awb_state).toBe('assigned');
  });

  it('marks a definite create refusal failed and allows a new shipment', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/orders/create/adhoc'] = [json({ message: 'Invalid pincode' }, 422)];
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'failed', last_error_code: 'http_422' });
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(0);
    const again = await mod.requestShipment(asAdmin, order, DIMS);
    expect(again.shipmentId).not.toBe(shipmentId);
  });

  it('backs off while another job holds the claim, without calling Shiprocket', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    await db.query(`UPDATE order_shipments SET claim_token=gen_random_uuid(), claimed_until=now()+interval '1 minute' WHERE id=$1`, [shipmentId]);
    await expect(mod.handleCreateShipmentJob(accountA, { shipmentId }, META)).rejects.toMatchObject({ name: 'ShipmentBusyError' });
    expect(calls).toEqual([]);
    // An expired claim means the POST may have happened: reconcile, never re-post.
    await db.query(`UPDATE order_shipments SET claimed_until=now()-interval '1 second' WHERE id=$1`, [shipmentId]);
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, FINAL);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
    expect((await shipmentOf(order)).create_state).toBe('unknown');
  });

  it('a failed login before the create leaves the shipment unsent (no unknown, no exception) and the job retries', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    // An ageing cached token forces a login; the login times out, then answers 502.
    for (const reply of [new TypeError('login timeout'), json({ message: 'bad gateway' }, 502)]) {
      await db.query(`UPDATE courier_connections SET token_expires_at=now()+interval '1 hour' WHERE account_id=$1 AND status='active'`, [accountA]);
      routes['/auth/login'] = [reply];
      calls.length = 0;
      await expect(mod.handleCreateShipmentJob(accountA, { shipmentId }, META)).rejects.toMatchObject({ kind: 'unavailable' });
      expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
      expect(await shipmentOf(order)).toMatchObject({ create_state: 'creating', awb_state: 'none', claim_token: null });
      expect(await one('SELECT count(*)::int AS n FROM shipment_exceptions WHERE shipment_id=$1', [shipmentId])).toEqual({ n: 0 });
    }
    // The retry logs in and creates normally.
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(1);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'created', awb_state: 'assigned' });
  });

  it('does not create or assign once the order stopped being paid', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    await db.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [order]);
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(calls).toEqual([]);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'failed', last_error_code: 'order_not_paid' });
  });

  it('cancels before pickup only; the order stays paid', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    const ship = await shipmentOf(order);
    await db.query(`UPDATE order_shipments SET tracking_rank=30, tracking_status='picked_up' WHERE id=$1`, [shipmentId]);
    await expect(mod.cancelShipment(asAdmin, order)).rejects.toMatchObject({ code: 'conflict' });
    await db.query(`UPDATE order_shipments SET tracking_rank=20, tracking_status='awb_assigned' WHERE id=$1`, [shipmentId]);
    calls.length = 0;
    await mod.cancelShipment(asAdmin, order);
    expect(calls.map((c) => [c.path, c.body])).toEqual([['/orders/cancel', { ids: [Number(ship.sr_order_id)] }]]);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'cancelled', claim_token: null });
    expect(await one('SELECT status FROM orders WHERE id=$1', [order])).toEqual({ status: 'paid' });
    expect(await one(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id=$1 AND action='commerce.shipment_cancel'`, [shipmentId])).toEqual({ n: 1 });
    // A provider refusal leaves the shipment as it was.
    const other = await paidOrder();
    const second = await mod.requestShipment(asAdmin, other, DIMS);
    await mod.handleCreateShipmentJob(accountA, { shipmentId: second.shipmentId }, META);
    routes['/orders/cancel'] = [json({ message: 'cannot cancel' }, 400)];
    await expect(mod.cancelShipment(asAdmin, other)).rejects.toMatchObject({ code: 'conflict' });
    expect(await shipmentOf(other)).toMatchObject({ create_state: 'created', claim_token: null });
  });

  it('re-logs in once on a 401 and marks the connection token_invalid when the stored user is refused', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    routes['/orders/create/adhoc'] = [json({ message: 'Token expired' }, 401)];
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(pathsCalled('/auth/login')).toHaveLength(1);
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(2);
    expect((await shipmentOf(order)).create_state).toBe('created');

    const order2 = await paidOrder();
    const second = await mod.requestShipment(asAdmin, order2, DIMS);
    routes['/orders/create/adhoc'] = [json({}, 401)];
    routes['/auth/login'] = [json({ message: 'Invalid credentials' }, 401)];
    await mod.handleCreateShipmentJob(accountA, { shipmentId: second.shipmentId }, META);
    expect(await shipmentOf(order2)).toMatchObject({ create_state: 'failed', last_error_code: 'auth' });
    expect(await one('SELECT status, last_error_code FROM courier_connections WHERE account_id=$1 AND status<>$2', [accountA, 'disconnected']))
      .toEqual({ status: 'token_invalid', last_error_code: 'auth' });
    // Reconnecting with the password restores it.
    await conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Warehouse 2', defaults: DIMS });
    expect(await one('SELECT status FROM courier_connections WHERE account_id=$1 AND status<>$2', [accountA, 'disconnected'])).toEqual({ status: 'active' });
  });

  it('sweeps only connected workspaces: polls, reconciles and resumes without re-creating', async () => {
    const schedule = await sweep.scheduleFulfilmentSweeps(Date.now(), true);
    expect(schedule).toBeGreaterThan(0);
    const slotJobs = (await db.query(`SELECT tenant_id::text AS t FROM jobs WHERE type='fulfilment.sweep' AND tenant_id=ANY($1::uuid[])`,
      [[accountA, accountB, accountC]])).rows.map((r) => r.t);
    expect(slotJobs).toContain(accountA);
    expect(slotJobs).not.toContain(accountB);

    const quiet = await paidOrder();
    const polled = await mod.requestShipment(asAdmin, quiet, DIMS);
    await mod.handleCreateShipmentJob(accountA, { shipmentId: polled.shipmentId }, META);
    await db.query(`UPDATE order_shipments SET tracking_event_at=now()-interval '4 hours' WHERE id=$1`, [polled.shipmentId]);
    const stale = await paidOrder();
    const old = await mod.requestShipment(asAdmin, stale, DIMS);
    await mod.handleCreateShipmentJob(accountA, { shipmentId: old.shipmentId }, META);
    await db.query(`UPDATE order_shipments SET tracking_event_at=now()-interval '11 days', created_at=now()-interval '11 days' WHERE id=$1`, [old.shipmentId]);
    const lost = await paidOrder();
    const unknown = await mod.requestShipment(asAdmin, lost, DIMS);
    await db.query(`UPDATE order_shipments SET create_state='unknown' WHERE id=$1`, [unknown.shipmentId]);
    const neverSent = await paidOrder();
    const unsent = await mod.requestShipment(asAdmin, neverSent, DIMS);
    await db.query(`UPDATE jobs SET status='failed' WHERE dedupe_key=$1`, [`shpcreate:${unsent.shipmentId}`]);
    await db.query(`UPDATE order_shipments SET created_at=now()-interval '1 hour' WHERE id=$1`, [unsent.shipmentId]);

    calls.length = 0;
    const summary = await sweep.runFulfilmentSweep(accountA);
    expect(tracked.enqueue).toHaveBeenCalledWith(expect.anything(), accountA, polled.shipmentId);
    expect(await one(`SELECT kind FROM shipment_exceptions WHERE shipment_id=$1 AND status='open'`, [old.shipmentId])).toEqual({ kind: 'stale_tracking' });
    expect(await one(`SELECT kind FROM shipment_exceptions WHERE shipment_id=$1 AND status='open'`, [unknown.shipmentId])).toEqual({ kind: 'create_unknown' });
    expect(pathsCalled('/orders/create/adhoc')).toHaveLength(0);
    expect(pathsCalled('/courier/assign/awb')).toHaveLength(0);
    expect(await one(`SELECT status FROM jobs WHERE dedupe_key=$1`, [`shpcreate:${unsent.shipmentId}`])).toEqual({ status: 'pending' });
    expect(summary.failures).toBe(0);

    // Switched off: nothing is queried or called.
    process.env.SHIPROCKET_DISABLED = 'true';
    calls.length = 0;
    tracked.enqueue.mockClear();
    await sweep.runFulfilmentSweep(accountA);
    await mod.handleCreateShipmentJob(accountA, { shipmentId: unsent.shipmentId }, META);
    expect(calls).toEqual([]);
    expect(tracked.enqueue).not.toHaveBeenCalled();
  });

  it('disconnects without a provider call, blanking secrets; later jobs call nothing', async () => {
    const order = await paidOrder();
    const { shipmentId } = await mod.requestShipment(asAdmin, order, DIMS);
    calls.length = 0;
    await conn.disconnectCourier(asAdmin);
    expect(calls).toEqual([]);
    expect(await one(`SELECT api_password_enc, token_enc, webhook_token_hash, status FROM courier_connections WHERE account_id=$1
      ORDER BY connected_at DESC LIMIT 1`, [accountA])).toEqual({ api_password_enc: null, token_enc: null, webhook_token_hash: null, status: 'disconnected' });
    await mod.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(calls).toEqual([]);
    expect(await shipmentOf(order)).toMatchObject({ create_state: 'failed', last_error_code: 'not_connected' });
    await expect(mod.requestShipment(asAdmin, await paidOrder(), DIMS)).rejects.toMatchObject({ code: 'not_connected' });
    expect(await conn.loadCourierSecrets(accountA)).toBeNull();
    expect(await one(`SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='integrations.shiprocket_disconnect'`, [accountA])).toEqual({ n: 1 });
  });

  it('an ambiguous shipment left on a replaced connection gets its exception once, with no provider call', async () => {
    const reconnect = () => conn.saveCourierConnection(asAdmin, { email: 'api@example.invalid', password: 'secret-pass', pickup_location: 'Primary', defaults: DIMS });
    await reconnect();
    const createOrder = await paidOrder(), awbOrder = await paidOrder();
    const created = await mod.requestShipment(asAdmin, createOrder, DIMS);
    const assigned = await mod.requestShipment(asAdmin, awbOrder, DIMS);
    await db.query(`UPDATE order_shipments SET create_state='unknown' WHERE id=$1`, [created.shipmentId]);
    await db.query(`UPDATE order_shipments SET create_state='created', awb_state='unknown', sr_order_id='5001', sr_shipment_id='5002'
      WHERE id=$1`, [assigned.shipmentId]);
    await conn.disconnectCourier(asAdmin);
    await reconnect();

    calls.length = 0;
    // The create job finds the row's connection replaced: it opens create_unknown instead of returning silently.
    await mod.handleCreateShipmentJob(accountA, { shipmentId: created.shipmentId }, META);
    await mod.handleCreateShipmentJob(accountA, { shipmentId: created.shipmentId }, META);
    // The sweep (live connection only for reconcile) opens awb_unknown for the replaced connection's row.
    await sweep.runFulfilmentSweep(accountA);
    await sweep.runFulfilmentSweep(accountA);
    const opened = async (id: string) => (await db.query(`SELECT kind, status FROM shipment_exceptions WHERE shipment_id=$1`, [id])).rows;
    expect(await opened(created.shipmentId)).toEqual([{ kind: 'create_unknown', status: 'open' }]);
    expect(await opened(assigned.shipmentId)).toEqual([{ kind: 'awb_unknown', status: 'open' }]);
    expect(calls.filter((c) => c.path !== '/auth/login')).toEqual([]);

    // Staff can now free the order: "recreate" lets a new shipment be requested.
    const { resolveShipmentException } = await import('./exceptions');
    const [exception] = (await db.query(`SELECT id::text AS id FROM shipment_exceptions WHERE shipment_id=$1`, [created.shipmentId])).rows;
    await resolveShipmentException(asAdmin, exception.id, 'recreate');
    await expect(mod.requestShipment(asAdmin, createOrder, DIMS)).resolves.toMatchObject({ shipmentId: expect.any(String) });
  });
});
