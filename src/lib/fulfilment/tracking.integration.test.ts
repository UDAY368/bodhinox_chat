import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The FUL-02 gate on PostgreSQL (Phase 9, design §9 test 3, T5). No provider
// call is ever made: Shiprocket's tracking read-back is a spy keyed by AWB, and
// the webhook token check (T4) is a spy too. Everything else is real: the
// route's receipt and coalesced job, the job's locks, the fold over stored
// scans, the system order transitions, notices, exceptions and audit rows.
const h = vi.hoisted(() => ({
  scans: new Map<string, Array<{ date: string; code: string; label?: string }>>(),
  calls: [] as string[],
  validToken: 'valid-tracking-token-0123456789abcdef',
  tokenAccount: '',
}));
vi.mock('./shiprocket-client', async (original) => ({
  ...(await original<typeof import('./shiprocket-client')>()),
  shiprocketCall: vi.fn(async (_account: string, method: string, path: string) => {
    h.calls.push(`${method} ${path}`);
    const awb = decodeURIComponent(path.split('/').pop() ?? '');
    const scans = h.scans.get(awb) ?? [];
    return { tracking_data: { shipment_track_activities: scans.map((s) => ({ date: s.date, 'sr-status': s.code, 'sr-status-label': s.label ?? 'X', location: 'Pune' })) } };
  }),
}));
vi.mock('./connection', async (original) => ({
  ...(await original<typeof import('./connection')>()),
  courierWebhookTokenMatches: vi.fn(async (accountId: string, token: string) => accountId === h.tokenAccount && token === h.validToken),
}));

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { cancelAndRefund, recordDelivery, recordDispatch, type StaffContext } from '@/lib/commerce/order-lifecycle';
import { POST as trackingRoute } from '@/app/api/fulfilment/tracking/[accountId]/route';
import { resolveShipmentException } from './exceptions';
import { handleShipmentTrackJob } from './tracking-job';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, ownerB];
const asAdmin: StaffContext = { accountId: accountA, userId: adminA, role: 'admin' };
const contactA = randomUUID(), contactB = randomUUID(), connA = randomUUID(), connB = randomUUID();
const productA = randomUUID(), variantA = randomUUID();
let db: pg.Client;
let seq = 0;

// Scan times (IST, as Shiprocket sends them).
const T = (hour: number) => `2026-10-${String(20 + Math.floor(hour / 24)).padStart(2, '0')} ${String(hour % 24).padStart(2, '0')}:00:00`;
const PICKED = (hour: number) => ({ date: T(hour), code: '42', label: 'PICKED UP' });
const TRANSIT = (hour: number) => ({ date: T(hour), code: '18', label: 'IN TRANSIT' });
const OFD = (hour: number) => ({ date: T(hour), code: '17', label: 'OUT FOR DELIVERY' });
const DELIVERED = (hour: number) => ({ date: T(hour), code: '7', label: 'DELIVERED' });
const RTO = (hour: number) => ({ date: T(hour), code: '9', label: 'RTO INITIATED' });
const CANCELLED = (hour: number) => ({ date: T(hour), code: '8', label: 'CANCELED' });
const LOST = (hour: number) => ({ date: T(hour), code: '12', label: 'LOST' });

async function order(status: string, account = accountA, contact = contactA): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,
      total_minor,status,priced_at,paid_at,amount_paid_minor) VALUES($1,$2,'storefront',$3,'INR',99800,0,15223,true,99800,$4,now(),
      CASE WHEN $4 IN ('paid','dispatched','fulfilled','cancelled') THEN now() END, CASE WHEN $4 IN ('paid','dispatched','fulfilled') THEN 99800 ELSE 0 END)`,
  [id, account, contact, status]);
  if (account === accountA) await db.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,name,quantity,unit_price_minor,currency,line_total_minor)
    VALUES($1,$2,$3,'ASH-60','Ashwagandha',2,49900,'INR',99800)`, [account, id, variantA]);
  return id;
}

async function shipment(orderId: string, account = accountA, conn = connA): Promise<{ id: string; awb: string }> {
  const id = randomUUID();
  seq += 1;
  const awb = `AWB${Date.now().toString(36).toUpperCase()}${seq}`;
  await db.query(`INSERT INTO order_shipments(id,account_id,order_id,connection_id,reference,create_state,awb_state,awb,courier_name,
      sr_order_id,sr_shipment_id,length_cm,breadth_cm,height_cm,weight_grams)
    VALUES($1,$2,$3,$4,$5,'created','assigned',$6,'Delhivery','1001','2001',10,10,10,500)`,
  [id, account, orderId, conn, `bx${randomUUID().replace(/-/g, '').slice(0, 12)}`, awb]);
  return { id, awb };
}

const statusOf = async (id: string) => (await db.query('SELECT status FROM orders WHERE id=$1', [id])).rows[0].status as string;
const liveRow = (orderId: string) => db.query(`INSERT INTO order_shipments(account_id,order_id,connection_id,reference,length_cm,breadth_cm,
  height_cm,weight_grams) VALUES($1,$2,$3,$4,10,10,10,500)`, [accountA, orderId, connA, `bx${randomUUID().replace(/-/g, '').slice(0, 12)}`]);
const shipmentRow = async (id: string) => (await db.query(`SELECT tracking_status, tracking_rank, tracking_event_at, provider_dispatched_at,
  provider_delivered_at FROM order_shipments WHERE id=$1`, [id])).rows[0];
const notices = async (orderId: string) => (await db.query(`SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND dedupe_key LIKE $2 ORDER BY dedupe_key`,
  [accountA, `ofu:${orderId}:%`])).rows.map((r) => r.dedupe_key.split(':')[2]);
const exceptions = async (shipmentId: string) => (await db.query(`SELECT id, kind, observed_status, status FROM shipment_exceptions
  WHERE shipment_id=$1 ORDER BY created_at, kind`, [shipmentId])).rows;
const transitions = async (orderId: string) => (await db.query(`SELECT from_status, to_status, actor FROM order_events
  WHERE order_id=$1 AND kind='status_changed'
  ORDER BY created_at, array_position(ARRAY['paid','dispatched','fulfilled'], from_status), id`, [orderId])).rows;
const track = (s: { id: string }, account = accountA) => handleShipmentTrackJob(account, { shipmentId: s.id });
const push = (account: string, body: unknown, token = h.validToken) => trackingRoute(
  new Request('http://localhost/api/fulfilment/tracking', { method: 'POST', headers: { 'x-api-key': token }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ accountId: account }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('courier tracking (FUL-02) on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    h.tokenAccount = accountA;
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 track', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Track A',$2),($3,'Track B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($4,$5,'owner')`,
      [accountA, ownerA, adminA, accountB, ownerB]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550941'),($4,$5,$6,'Ravi','14155550942')`,
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    await db.query(`INSERT INTO shop_products(id,account_id,name,follow_up_template,follow_up_template_language,follow_up_after_days)
      VALUES($1,$2,'Ashwagandha','refill_reminder','en',30)`, [productA, accountA]);
    await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,price_minor) VALUES($1,$2,$3,'ASH-60',49900)`, [variantA, accountA, productA]);
    await db.query(`INSERT INTO courier_connections(id,account_id,api_email,api_password_enc,token_enc,webhook_token_hash)
      VALUES($1,$2,'api@example.invalid','enc-p','enc-t',repeat('a',64)),($3,$4,'api@example.invalid','enc-p','enc-t',repeat('b',64))`,
    [connA, accountA, connB, accountB]);
  });

  beforeEach(() => {
    h.scans.clear();
    h.calls.length = 0;
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query(`DELETE FROM webhook_receipts WHERE dedupe_key LIKE 'shiprocket:' || $1 || ':%'`, [accountA]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('the gate: repeated, older and contradicting events give one dispatch, one delivery and one contradiction', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), TRANSIT(5)]);
    await track(s);
    expect(await statusOf(o)).toBe('dispatched');
    expect(await notices(o)).toEqual(['dispatched']);

    // Shiprocket pushes "delivered" three times: one receipt, one coalesced job, no change until the re-fetch.
    h.scans.set(s.awb, [PICKED(1), TRANSIT(5), OFD(20), DELIVERED(23)]);
    for (let i = 0; i < 3; i++)
      expect((await push(accountA, { awb: s.awb, shipment_status_id: 7, current_timestamp: '20 10 2026 23:00:00' })).status).toBe(200);
    const queued = (await db.query(`SELECT status FROM jobs WHERE dedupe_key=$1`, [`shptrk:${s.id}`])).rows;
    expect(queued).toEqual([{ status: 'pending' }]);
    expect((await db.query(`SELECT count(*)::int AS n FROM webhook_receipts WHERE dedupe_key LIKE $1`, [`shiprocket:${accountA}:%`])).rows[0].n).toBe(1);
    expect(await statusOf(o)).toBe('dispatched');
    for (let i = 0; i < 3; i++) await track(s);

    // Then an older "in transit" and an RTO after delivery arrive.
    h.scans.set(s.awb, [PICKED(1), TRANSIT(5), TRANSIT(10), OFD(20), DELIVERED(23), RTO(30)]);
    await track(s);
    await track(s);

    expect(await statusOf(o)).toBe('fulfilled');
    expect(await transitions(o)).toEqual([
      { from_status: 'paid', to_status: 'dispatched', actor: 'system' },
      { from_status: 'dispatched', to_status: 'fulfilled', actor: 'system' },
    ]);
    expect(await notices(o)).toEqual(['delivered', 'dispatched', 'feedback', 'product_follow_up']);
    expect(await exceptions(s.id)).toEqual([expect.objectContaining({ kind: 'contradiction', observed_status: 'rto_initiated', status: 'open' })]);
    const row = await shipmentRow(s.id);
    expect(row).toMatchObject({ tracking_status: 'delivered', tracking_rank: 90 });
    expect(row.provider_dispatched_at.toISOString()).toBe('2026-10-19T19:30:00.000Z');
    expect(row.provider_delivered_at.toISOString()).toBe('2026-10-20T17:30:00.000Z');
    expect((await db.query('SELECT fulfilment_recorded_by FROM orders WHERE id=$1', [o])).rows[0].fulfilment_recorded_by).toBeNull();
    // Only status, code and time are stored: no location.
    const cols = (await db.query(`SELECT * FROM shipment_tracking_events WHERE shipment_id=$1 LIMIT 1`, [s.id])).rows[0];
    expect(JSON.stringify(cols)).not.toContain('Pune');
  });

  it('the draft counterexample converges: rto_initiated@t7 seen before delivered@t6 ends like the sorted history', async () => {
    const o1 = await order('paid'), o2 = await order('paid');
    const late = await shipment(o1), sorted = await shipment(o2);
    h.scans.set(late.awb, [TRANSIT(1), RTO(7)]);
    await track(late);
    expect((await shipmentRow(late.id)).tracking_status).toBe('rto_initiated');
    h.scans.set(late.awb, [TRANSIT(1), DELIVERED(6), RTO(7)]);
    await track(late);
    h.scans.set(sorted.awb, [TRANSIT(1), DELIVERED(6), RTO(7)]);
    await track(sorted);
    const a = await shipmentRow(late.id), b = await shipmentRow(sorted.id);
    expect(a).toEqual(b);
    expect(a.tracking_status).toBe('delivered');
    expect(await statusOf(o1)).toBe('fulfilled');
    expect(await statusOf(o2)).toBe('fulfilled');
    expect((await exceptions(sorted.id)).map((e) => e.kind)).toEqual(['contradiction']);
  });

  it('8 scans arriving one by one in 20 random orders reach an identical final state', async () => {
    const scans = [PICKED(1), TRANSIT(3), TRANSIT(9), OFD(20), { date: T(21), code: '21', label: 'UNDELIVERED' }, OFD(44), DELIVERED(46), RTO(50)];
    const finals: string[] = [];
    let seed = 7;
    for (let run = 0; run < 20; run++) {
      const order_ = await order('paid');
      const s = await shipment(order_);
      const perm = [...scans];
      for (let i = perm.length - 1; i > 0; i--) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        const j = seed % (i + 1);
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      for (let i = 1; i <= perm.length; i++) {
        h.scans.set(s.awb, perm.slice(0, i));
        await track(s);
      }
      const row = await shipmentRow(s.id);
      finals.push(JSON.stringify({
        // The dispatched notice legitimately depends on whether a pickup scan was seen before the
        // delivery (none is sent once delivered); every other notice is exactly once.
        ...row, order: await statusOf(order_), notices: (await notices(order_)).filter((n) => n !== 'dispatched'),
        contradictions: (await exceptions(s.id)).filter((e) => e.kind === 'contradiction').map((e) => e.observed_status),
      }));
    }
    expect(new Set(finals).size).toBe(1);
    expect(JSON.parse(finals[0])).toMatchObject({ tracking_status: 'delivered', order: 'fulfilled', contradictions: ['rto_initiated'] });
  });

  it('concurrent identical jobs apply the delivery once', async () => {
    const o = await order('dispatched');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(30)]);
    await Promise.all(Array.from({ length: 5 }, () => track(s)));
    expect(await transitions(o)).toEqual([{ from_status: 'dispatched', to_status: 'fulfilled', actor: 'system' }]);
    expect(await notices(o)).toEqual(['delivered', 'feedback', 'product_follow_up']);
  });

  it('a pushed status changes nothing unless the re-fetch agrees', async () => {
    const o = await order('dispatched');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), TRANSIT(4)]);
    expect((await push(accountA, { awb: s.awb, shipment_status_id: 7, current_timestamp: '21 10 2026 10:00:00' })).status).toBe(200);
    await track(s);
    expect(await statusOf(o)).toBe('dispatched');
    expect(await notices(o)).toEqual([]);
    expect((await shipmentRow(s.id)).tracking_status).toBe('in_transit');
  });

  it('a wrong token is 401; another workspace’s AWB on this URL is ignored', async () => {
    const o = await order('paid', accountB, contactB);
    const sB = await shipment(o, accountB, connB);
    expect((await push(accountA, { awb: sB.awb, shipment_status_id: 7 }, 'wrong-token-0123456789abcdefghij')).status).toBe(401);
    expect((await push(accountB, { awb: sB.awb, shipment_status_id: 7 })).status).toBe(401);
    expect((await push(accountA, { awb: sB.awb, shipment_status_id: 7 })).status).toBe(200);
    expect((await db.query(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1`, [`shptrk:${sB.id}`])).rows[0].n).toBe(0);
    // A job for a shipment id from another workspace finds nothing and calls nobody.
    await handleShipmentTrackJob(accountA, { shipmentId: sB.id });
    expect(h.calls).toEqual([]);
  });

  it('staff delivered first, then the courier: only the provider evidence is added', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    await recordDispatch(asAdmin, o, { from: 'paid' });
    await recordDelivery(asAdmin, o, { from: 'dispatched' });
    const before = await notices(o);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(30)]);
    await track(s);
    expect(await notices(o)).toEqual(before);
    expect((await transitions(o)).map((t) => t.actor)).toEqual(['staff', 'staff']);
    expect((await shipmentRow(s.id)).provider_delivered_at).not.toBeNull();
    expect((await db.query('SELECT fulfilment_recorded_by FROM orders WHERE id=$1', [o])).rows[0].fulfilment_recorded_by).toBe(adminA);
  });

  it('a first event of "delivered" on a paid order goes paid → dispatched → fulfilled without a stale dispatched notice', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    h.scans.set(s.awb, [DELIVERED(30)]);
    await track(s);
    expect(await transitions(o)).toEqual([
      { from_status: 'paid', to_status: 'dispatched', actor: 'system' },
      { from_status: 'dispatched', to_status: 'fulfilled', actor: 'system' },
    ]);
    expect(await notices(o)).toEqual(['delivered', 'feedback', 'product_follow_up']);
  });

  it('accepting a correction writes an event and an audit row, keeps the order fulfilled, and survives a re-fetch', async () => {
    const o = await order('dispatched');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(20), RTO(25)]);
    await track(s);
    const [exc] = await exceptions(s.id);
    expect(exc).toMatchObject({ kind: 'contradiction', observed_status: 'rto_initiated' });
    await expect(resolveShipmentException({ accountId: accountA, userId: adminA, role: 'agent' }, exc.id, 'accept_correction'))
      .rejects.toThrow();
    await expect(resolveShipmentException(asAdmin, exc.id, 'recreate')).rejects.toMatchObject({ code: 'invalid' });
    const resolved = await resolveShipmentException(asAdmin, exc.id, 'accept_correction');
    expect(resolved).toMatchObject({ status: 'resolved', resolution: 'accept_correction', tracking_status: 'rto_initiated' });
    expect(await statusOf(o)).toBe('fulfilled');
    expect((await db.query(`SELECT kind, actor, actor_user_id, detail FROM order_events WHERE order_id=$1 AND kind='shipment_correction_accepted'`, [o])).rows)
      .toEqual([{ kind: 'shipment_correction_accepted', actor: 'staff', actor_user_id: adminA, detail: 'rto_initiated' }]);
    expect((await db.query(`SELECT action, metadata FROM audit_logs WHERE account_id=$1 AND resource_id=$2`, [accountA, exc.id])).rows)
      .toEqual([{ action: 'shipment.exception_resolved', metadata: expect.objectContaining({ kind: 'contradiction', resolution: 'accept_correction' }) }]);
    await expect(resolveShipmentException(asAdmin, exc.id, 'dismiss')).rejects.toMatchObject({ code: 'conflict' });

    h.scans.set(s.awb, [PICKED(1), DELIVERED(20), RTO(25), { date: T(40), code: '46', label: 'RTO IN TRANSIT' }]);
    await track(s);
    expect((await shipmentRow(s.id)).tracking_status).toBe('rto_in_transit');
    expect(await statusOf(o)).toBe('fulfilled');
    const after = await exceptions(s.id);
    expect(after.filter((e) => e.kind === 'contradiction' && e.status === 'open')).toEqual([]);
    expect(after.filter((e) => e.kind === 'rto')).toHaveLength(1);
  });

  it('a courier claim the order disagrees with opens order_conflict and changes nothing', async () => {
    const o = await order('cancelled');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(30)]);
    await track(s);
    await track(s);
    expect(await statusOf(o)).toBe('cancelled');
    expect(await notices(o)).toEqual([]);
    expect((await exceptions(s.id)).map((e) => [e.kind, e.observed_status])).toEqual([['order_conflict', 'delivered']]);
  });

  it('Cancel and refund is refused while a shipment with an AWB is live', async () => {
    const o = await order('paid');
    await shipment(o);
    await expect(cancelAndRefund(asAdmin, o, { refundedOutside: true })).rejects.toMatchObject({ code: 'shipment_live', status: 409 });
    expect(await statusOf(o)).toBe('paid');
  });

  it('a Shiprocket cancel before any dispatch scan frees the order for a new shipment, once, as the system', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    await expect(liveRow(o)).rejects.toThrow();
    h.scans.set(s.awb, [CANCELLED(2)]);
    await track(s);
    await track(s);
    expect((await db.query('SELECT create_state, tracking_status, claim_token FROM order_shipments WHERE id=$1', [s.id])).rows[0])
      .toEqual({ create_state: 'cancelled', tracking_status: 'cancelled', claim_token: null });
    expect((await db.query(`SELECT actor FROM order_events WHERE order_id=$1 AND kind='shipment_cancelled'`, [o])).rows).toEqual([{ actor: 'system' }]);
    expect(await statusOf(o)).toBe('paid');
    expect(await exceptions(s.id)).toEqual([]);
    // The one-live-shipment slot (partial unique index) is free again.
    await liveRow(o);
  });

  it('a cancel claimed by staff is left to staff; a cancel after a pickup scan opens an exception and keeps the slot', async () => {
    const o1 = await order('paid');
    const claimed = await shipment(o1);
    await db.query(`UPDATE order_shipments SET claim_token=gen_random_uuid(), claimed_until=now()+interval '1 minute' WHERE id=$1`, [claimed.id]);
    h.scans.set(claimed.awb, [CANCELLED(2)]);
    await track(claimed);
    expect((await db.query('SELECT create_state FROM order_shipments WHERE id=$1', [claimed.id])).rows[0].create_state).toBe('created');

    const o2 = await order('paid');
    const out = await shipment(o2);
    h.scans.set(out.awb, [PICKED(1), CANCELLED(5)]);
    await track(out);
    expect((await db.query('SELECT create_state FROM order_shipments WHERE id=$1', [out.id])).rows[0].create_state).toBe('created');
    expect((await exceptions(out.id)).map((e) => [e.kind, e.observed_status])).toEqual([['order_conflict', 'cancelled']]);
    await expect(liveRow(o2)).rejects.toThrow();
  });

  it('a lost parcel can be released with "recreate" after the admin checked with the courier', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    h.scans.set(s.awb, [LOST(3)]);
    await track(s);
    const [lost] = await exceptions(s.id);
    expect(lost).toMatchObject({ kind: 'lost_or_damaged', status: 'open' });
    await resolveShipmentException(asAdmin, lost.id, 'recreate');
    expect((await db.query('SELECT create_state FROM order_shipments WHERE id=$1', [s.id])).rows[0].create_state).toBe('failed');
    await liveRow(o);
  });

  it('a second contradiction with another observed status opens its own exception while the first is open', async () => {
    const o = await order('dispatched');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(20), RTO(25)]);
    await track(s);
    h.scans.set(s.awb, [PICKED(1), DELIVERED(20), RTO(25), LOST(30)]);
    await track(s);
    await track(s);
    const open = (await exceptions(s.id)).filter((e) => e.kind === 'contradiction' && e.status === 'open').map((e) => e.observed_status);
    expect(open.sort()).toEqual(['lost', 'rto_initiated']);
  });

  it('a push while the re-fetch job is running queues one follow-up instead of being dropped', async () => {
    const o = await order('dispatched');
    const s = await shipment(o);
    h.scans.set(s.awb, [PICKED(1)]);
    expect((await push(accountA, { awb: s.awb, shipment_status_id: 17, current_timestamp: '21 10 2026 09:00:00' })).status).toBe(200);
    await db.query(`UPDATE jobs SET status='running', lease_until=now()+interval '90 seconds' WHERE dedupe_key=$1`, [`shptrk:${s.id}`]);
    for (const ts of ['21 10 2026 11:00:00', '21 10 2026 11:05:00'])
      expect((await push(accountA, { awb: s.awb, shipment_status_id: 7, current_timestamp: ts })).status).toBe(200);
    const jobs = (await db.query(`SELECT dedupe_key, status, payload FROM jobs WHERE dedupe_key LIKE $1 ORDER BY dedupe_key`, [`shptrk:${s.id}%`])).rows;
    expect(jobs).toEqual([
      { dedupe_key: `shptrk:${s.id}`, status: 'running', payload: { shipmentId: s.id } },
      { dedupe_key: `shptrk:${s.id}:next`, status: 'pending', payload: { shipmentId: s.id } },
    ]);
  });

  it('no active connection or the kill switch: no provider call', async () => {
    const o = await order('paid');
    const s = await shipment(o);
    h.scans.set(s.awb, [DELIVERED(30)]);
    process.env.SHIPROCKET_DISABLED = 'true';
    try {
      await track(s);
    } finally {
      delete process.env.SHIPROCKET_DISABLED;
    }
    await db.query(`UPDATE courier_connections SET status='token_invalid' WHERE id=$1`, [connA]);
    try {
      await track(s);
    } finally {
      await db.query(`UPDATE courier_connections SET status='active' WHERE id=$1`, [connA]);
    }
    expect(h.calls).toEqual([]);
    expect(await statusOf(o)).toBe('paid');
  });
});
