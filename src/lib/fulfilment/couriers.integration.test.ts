import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import type { FulfilmentActor } from './types';

// Store Phase 5 (more couriers) on PostgreSQL: Delhivery and Shipway connections are per workspace, admin-only, never
// return their secret; a shipment created with a courier is created, tracked and cancelled through that courier.
// Only the courier HTTP (global fetch, behind leaseFetch) is fake; rows, RLS, grants, claims and audit rows are real.
// Delhivery and Shipway are NOT TESTED AGAINST THE LIVE API: the stub below encodes the documented shapes we assumed.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, ownerB];
const asAdmin: FulfilmentActor = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: FulfilmentActor = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: FulfilmentActor = { accountId: accountB, userId: ownerB, role: 'owner' };
const contactA = randomUUID();
const DIMS = { length_cm: 20, breadth_cm: 15, height_cm: 10, weight_grams: 750 };
const ADDRESS = { name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 MG Road', line2: null, city: 'Bengaluru', state: 'Karnataka',
  state_code: 'KA', postal_code: '560001', country: 'IN', instructions: null };
const META = { attempts: 1, maxAttempts: 5 };
const TOKEN = 'delhivery-api-token-SECRET-0123456789';
const LICENCE = 'shipway-licence-SECRET-0123456789';
let waybills = 0;
let lastWaybill = '';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn<typeof fetch>();
const calls: { method: string; url: string; auth: string | null; body: string | null }[] = [];
let tokenOk = true;
let trackBody: unknown = { ShipmentData: [] };

function courierReply(url: URL, body: string | null): Response {
  const path = url.pathname + url.search;
  if (url.host === 'track.delhivery.com') {
    if (!tokenOk) return json({}, 401);
    if (path.startsWith('/c/api/pin-codes')) return json({ delivery_codes: [] });
    if (path.startsWith('/waybill/api/bulk')) { waybills += 1; lastWaybill = String(1234567890000 + waybills); return json({ waybill: [lastWaybill] }); }
    if (path.startsWith('/api/cmu/create.json')) {
      const sent = JSON.parse(new URLSearchParams(body ?? '').get('data') ?? '{}').shipments?.[0];
      return json({ success: true, packages: [{ status: 'Success', waybill: sent?.waybill, refnum: sent?.order }] });
    }
    if (path.startsWith('/fm/request/new')) return json({ pickup_id: 5 });
    if (path.startsWith('/api/p/edit')) return json({ status: true });
    if (path.startsWith('/api/v1/packages/json')) return json(trackBody);
  }
  if (url.host === 'shipway.in') {
    if (!tokenOk) return json({}, 401);
    if (path.endsWith('/authenticateUser')) return json({ status: 'Success' });
  }
  return json({ message: 'unexpected' }, 404);
}

let db: pg.Client;
const one = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows[0];

async function paidOrder(account = accountA) {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
      status,priced_at,paid_at,amount_paid_minor,shipping_address) VALUES($1,$2,'storefront',$3,'INR',49800,5000,0,true,54800,'paid',now(),now(),54800,$4)`,
  [id, account, account === accountA ? contactA : null, JSON.stringify(ADDRESS)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,name,sku,hsn_code,quantity,unit_price_minor,currency,tax_rate_bps)
    VALUES($1,$2,'Triphala churna','TRI-100','3004',2,24900,'INR',1200)`, [account, id]);
  return id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Delhivery and Shipway on PostgreSQL', { timeout: 120_000 }, () => {
  let provider: typeof import('./provider-connection');
  let shipments: typeof import('./shipments');
  let track: typeof import('./tracking-job');
  let conn: typeof import('./connection');

  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P5 couriers', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Courier A',$2),($3,'Courier B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, ownerA, adminA, agentA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone,email) VALUES($1,$2,$3,'Asha','919876543210','asha@example.invalid')",
      [contactA, accountA, ownerA]);
    vi.stubGlobal('fetch', fetchMock);
    provider = await import('./provider-connection');
    shipments = await import('./shipments');
    track = await import('./tracking-job');
    conn = await import('./connection');
  });

  beforeEach(() => {
    calls.length = 0;
    tokenOk = true;
    delete process.env.DELHIVERY_DISABLED;
    delete process.env.SHIPWAY_DISABLED;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ method: init?.method ?? 'GET', url: String(input), auth: headers?.Authorization ?? null, body: init?.body ? String(init.body) : null });
      return courierReply(url, init?.body ? String(init.body) : null);
    });
  });

  afterEach(() => { delete process.env.DELHIVERY_DISABLED; delete process.env.SHIPWAY_DISABLED; });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('is off until an admin connects: not connected for everyone, nothing called', async () => {
    const view = await withTenant(asAdmin, (tx) => provider.getProviderConnections(tx, accountA));
    expect(view.map((c) => [c.provider, c.connected, c.tested_live])).toEqual([['delhivery', false, false], ['shipway', false, false]]);
    await expect(shipments.requestShipment(asAdmin, await paidOrder(), DIMS, 'delhivery')).rejects.toMatchObject({ code: 'not_connected' });
    await expect(provider.loadProviderSecrets(accountA, 'delhivery')).rejects.toMatchObject({ code: 'not_connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connects Delhivery as an admin: checks the token first, stores it encrypted, returns a masked hint only', async () => {
    tokenOk = false;
    await expect(provider.saveProviderConnection(asAdmin, 'delhivery', { label: 'Acme Retail', secret: TOKEN, pickup_location: 'Main Warehouse' }))
      .rejects.toMatchObject({ code: 'auth' });
    expect(await one(`SELECT count(*)::int AS n FROM courier_connections WHERE account_id=$1 AND provider='delhivery'`, [accountA])).toEqual({ n: 0 });

    tokenOk = true;
    const saved = await provider.saveProviderConnection(asAdmin, 'delhivery', {
      label: 'Acme Retail', secret: TOKEN, pickup_location: 'Main Warehouse', defaults: { length_cm: 10, breadth_cm: 10, height_cm: 5, weight_grams: 500 },
    });
    expect(calls[0]).toMatchObject({ url: expect.stringContaining('https://track.delhivery.com/c/api/pin-codes'), auth: `Token ${TOKEN}` });
    expect(saved).toMatchObject({ provider: 'delhivery', connected: true, status: 'active', label: 'Acme Retail', pickup_location: 'Main Warehouse', tested_live: false });
    expect(saved.secret_hint).toMatch(/^••••.{0,3}$/);
    // The secret is in no API-shaped value, and the stored column is ciphertext.
    const everything = JSON.stringify([saved, await withTenant(asAdmin, (tx) => provider.getProviderConnections(tx, accountA))]);
    expect(everything).not.toContain(TOKEN);
    const row = await one(`SELECT api_password_enc, provider FROM courier_connections WHERE account_id=$1 AND provider='delhivery'`, [accountA]);
    expect(row.api_password_enc).toBeTruthy();
    expect(row.api_password_enc).not.toContain(TOKEN);
    expect((await provider.loadProviderSecrets(accountA, 'delhivery')).secret).toBe(TOKEN);
    // The app role cannot read the encrypted column back.
    await expect(withTenant(asAdmin, (tx) => tx.$queryRawUnsafe(`SELECT api_password_enc FROM courier_connections`))).rejects.toThrow();
    // Audited by id and flags only.
    const audit = await one(`SELECT metadata::text AS m FROM audit_logs WHERE account_id=$1 AND action='integrations.delhivery_connect'`, [accountA]);
    expect(audit.m).not.toContain(TOKEN);
  });

  it('updates with a blank secret (keeps the stored one) but refuses a blank secret for another label', async () => {
    const updated = await provider.saveProviderConnection(asAdmin, 'delhivery', { label: 'Acme Retail', secret: '', pickup_location: 'Second Warehouse' });
    expect(updated.pickup_location).toBe('Second Warehouse');
    expect(calls[0].auth).toBe(`Token ${TOKEN}`);
    await expect(provider.saveProviderConnection(asAdmin, 'delhivery', { label: 'Someone Else', secret: '', pickup_location: 'x' }))
      .rejects.toMatchObject({ code: 'auth' });
    expect(await one(`SELECT count(*)::int AS n FROM courier_connections WHERE account_id=$1 AND provider='delhivery' AND status<>'disconnected'`, [accountA])).toEqual({ n: 1 });
  });

  it('an agent cannot connect, test or disconnect', async () => {
    await expect(provider.saveProviderConnection(asAgent, 'shipway', { label: 'u', secret: LICENCE })).rejects.toThrow();
    await expect(provider.testProviderConnection(asAgent, 'delhivery', { label: 'Acme Retail', secret: TOKEN })).rejects.toThrow();
    await expect(provider.disconnectProvider(asAgent, 'delhivery')).rejects.toThrow();
    expect(await one(`SELECT count(*)::int AS n FROM courier_connections WHERE account_id=$1 AND provider='delhivery' AND status='active'`, [accountA])).toEqual({ n: 1 });
    expect(await one(`SELECT count(*)::int AS n FROM courier_connections WHERE account_id=$1 AND provider='shipway'`, [accountA])).toEqual({ n: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps credentials per workspace: another workspace sees nothing and cannot touch them', async () => {
    const other = await withTenant(asB, (tx) => provider.getProviderConnections(tx, accountB));
    expect(other.every((c) => !c.connected && c.secret_hint === null)).toBe(true);
    await expect(provider.loadProviderSecrets(accountB, 'delhivery')).rejects.toMatchObject({ code: 'not_connected' });
    await provider.disconnectProvider(asB, 'delhivery');
    expect(await one(`SELECT status FROM courier_connections WHERE account_id=$1 AND provider='delhivery'`, [accountA])).toEqual({ status: 'active' });
    // A workspace's app-role transaction does not even see another workspace's rows.
    expect(await withTenant(asB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM courier_connections WHERE account_id=${accountA}::uuid`)).toEqual([{ n: 0 }]);
  });

  it('connects Shipway next to Delhivery and Shiprocket: one live connection per courier, each separate', async () => {
    const shipway = await provider.saveProviderConnection(asAdmin, 'shipway', { label: 'acme-user', secret: LICENCE });
    expect(shipway).toMatchObject({ provider: 'shipway', connected: true, pickup_location: null });
    expect(calls[0]).toMatchObject({ url: 'https://shipway.in/api/authenticateUser' });
    expect(calls[0].auth).toBe(`Basic ${Buffer.from(`acme-user:${LICENCE}`).toString('base64')}`);
    expect(JSON.stringify(shipway)).not.toContain(LICENCE);
    // A Shiprocket connection (as before Phase 5) sits beside them and is not mistaken for them.
    await db.query(`INSERT INTO courier_connections(account_id, provider, api_email, pickup_location) VALUES($1,'shiprocket','api@example.invalid','Primary')`, [accountA]);
    expect(await withTenant(asAdmin, (tx) => conn.getCourierConnection(tx, accountA))).toMatchObject({ connected: true, api_email: 'api@example.invalid' });
    const both = await withTenant(asAdmin, (tx) => provider.getProviderConnections(tx, accountA));
    expect(both.map((c) => [c.provider, c.connected])).toEqual([['delhivery', true], ['shipway', true]]);
    await expect(db.query(`INSERT INTO courier_connections(account_id, provider, api_email) VALUES($1,'delhivery','dup')`, [accountA])).rejects.toThrow();
  });

  it('creates a Delhivery shipment through Delhivery only, and tracks it through Delhivery', async () => {
    const orderId = await paidOrder();
    const { shipmentId } = await shipments.requestShipment(asAdmin, orderId, DIMS, 'delhivery');
    expect(await one(`SELECT provider FROM order_shipments WHERE id=$1`, [shipmentId])).toEqual({ provider: 'delhivery' });
    expect(fetchMock).not.toHaveBeenCalled(); // queued only: nothing is sent while acknowledging

    await shipments.handleCreateShipmentJob(accountA, { shipmentId }, META);
    const row = await one(`SELECT create_state, awb_state, awb, courier_name, sr_order_id, sr_shipment_id FROM order_shipments WHERE id=$1`, [shipmentId]);
    const waybill = lastWaybill;
    expect(row).toEqual({ create_state: 'created', awb_state: 'assigned', awb: waybill, courier_name: 'Delhivery', sr_order_id: waybill, sr_shipment_id: waybill });
    expect(calls.every((c) => c.url.startsWith('https://track.delhivery.com/'))).toBe(true);
    expect(calls.every((c) => c.auth === `Token ${TOKEN}`)).toBe(true);
    const create = calls.find((c) => c.url.includes('/api/cmu/create.json'))!;
    expect(new URLSearchParams(create.body!).get('data')).toContain((await one(`SELECT reference FROM order_shipments WHERE id=$1`, [shipmentId])).reference);
    expect(calls.some((c) => c.url.includes('/fm/request/new/'))).toBe(true);

    // The track job reads Delhivery, not Shiprocket.
    calls.length = 0;
    trackBody = { ShipmentData: [{ Shipment: { AWB: waybill, Status: { Status: 'Delivered', StatusType: 'DL', StatusDateTime: '2026-11-18T14:05:00' },
      Scans: [{ ScanDetail: { ScanType: 'PU', Scan: 'Picked up', ScanDateTime: '2026-11-16T09:00:00' } }] } }] };
    await track.handleShipmentTrackJob(accountA, { shipmentId });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://track.delhivery.com/api/v1/packages/json/?waybill=${waybill}`);
    expect(await one(`SELECT tracking_status FROM order_shipments WHERE id=$1`, [shipmentId])).toEqual({ tracking_status: 'delivered' });
    expect(await one(`SELECT count(*)::int AS n FROM shipment_tracking_events WHERE shipment_id=$1`, [shipmentId])).toEqual({ n: 3 });
  });

  it('cancels a Delhivery shipment through Delhivery', async () => {
    const orderId = await paidOrder();
    const { shipmentId } = await shipments.requestShipment(asAdmin, orderId, DIMS, 'delhivery');
    await shipments.handleCreateShipmentJob(accountA, { shipmentId }, META);
    const waybill = lastWaybill;
    calls.length = 0;
    await shipments.cancelShipment(asAdmin, orderId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://track.delhivery.com/api/p/edit', auth: `Token ${TOKEN}` });
    expect(JSON.parse(calls[0].body!)).toEqual({ waybill, cancellation: 'true' });
    expect(await one(`SELECT create_state, tracking_status FROM order_shipments WHERE id=$1`, [shipmentId])).toEqual({ create_state: 'cancelled', tracking_status: 'cancelled' });
    // Another workspace cannot see or cancel the shipment.
    await expect(shipments.cancelShipment(asB, orderId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('picks the default courier (Shiprocket when connected) and honours an explicit choice', async () => {
    const first = await shipments.requestShipment(asAdmin, await paidOrder(), DIMS);
    expect(await one(`SELECT provider FROM order_shipments WHERE id=$1`, [first.shipmentId])).toEqual({ provider: 'shiprocket' });
    const second = await shipments.requestShipment(asAdmin, await paidOrder(), DIMS, 'shipway');
    expect(await one(`SELECT provider FROM order_shipments WHERE id=$1`, [second.shipmentId])).toEqual({ provider: 'shipway' });
    await expect(shipments.requestShipment(asAdmin, await paidOrder(), DIMS, 'nope' as never)).rejects.toMatchObject({ code: 'invalid' });
    process.env.SHIPWAY_DISABLED = 'true';
    await expect(shipments.requestShipment(asAdmin, await paidOrder(), DIMS, 'shipway')).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('disconnect clears the secret and later jobs for that courier call nothing', async () => {
    const orderId = await paidOrder();
    const { shipmentId } = await shipments.requestShipment(asAdmin, orderId, DIMS, 'shipway');
    await provider.disconnectProvider(asAdmin, 'shipway');
    expect(await one(`SELECT status, api_password_enc, secret_hint FROM courier_connections WHERE account_id=$1 AND provider='shipway'`, [accountA]))
      .toEqual({ status: 'disconnected', api_password_enc: null, secret_hint: null });
    expect(await one(`SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='integrations.shipway_disconnect'`, [accountA])).toEqual({ n: 1 });
    calls.length = 0;
    await shipments.handleCreateShipmentJob(accountA, { shipmentId }, META);
    expect(calls).toEqual([]);
    expect(JSON.stringify(await db.query(`SELECT metadata::text FROM audit_logs WHERE account_id=$1`, [accountA]))).not.toContain(LICENCE);
  });
});
