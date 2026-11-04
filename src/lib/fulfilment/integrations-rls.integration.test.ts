import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';

// Schema-level guarantees of the Phase 9 migrations (T1): column grants that keep
// secrets and claim tokens from the app role, viewer isolation, worker-only
// definers, the widened CHECKs, the open-task partial unique, the opt-in freeze
// and the plan seeding. Service behaviour lives in the T2-T6 tests.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, viewerA, ownerB];
const asAdmin: TenantContext = { accountId: accountA, userId: ownerA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const asWorkerA: TenantContext = { accountId: accountA, role: 'owner' };
const zoomAccount = `zacct_${randomUUID().slice(0, 8)}`;
const ids = {
  location: randomUUID(), service: randomUUID(), staff: randomUUID(), contact: randomUUID(), appointment: randomUUID(),
  meetingConn: randomUUID(), meeting: randomUUID(), courierConn: randomUUID(), order: randomUUID(), cartOrder: randomUUID(),
  shipment: randomUUID(), exception: randomUUID(), product: randomUUID(),
};
let owner: pg.Client;
const fails = (work: Promise<unknown>) => work.then(() => false, () => true);
const app = (ctx: TenantContext, sql: string, ...values: unknown[]) =>
  withTenant(ctx, (tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values));
const worker = (ctx: TenantContext, sql: string, ...values: unknown[]) =>
  withTenant(ctx, (tx) => tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values), getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 9 integration tables on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 RLS', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P9 A',$2),($3,'P9 B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'P9 contact','14155550931')", [ids.contact, accountA, ownerA]);
    await owner.query("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'Clinic','Asia/Kolkata')", [ids.location, accountA]);
    await owner.query("INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes) VALUES($1,$2,'Consult','online',30)", [ids.service, accountA]);
    await owner.query("INSERT INTO appointment_staff(id,account_id,display_name,user_id) VALUES($1,$2,'Dr A',$3)", [ids.staff, accountA, agentA]);
    await owner.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,
        confirmed_at,service_name) VALUES($1,$2,$3,$4,$5,$6,now()+interval '2 days',now()+interval '2 days 30 minutes','Asia/Kolkata',
        'confirmed','staff',now(),'Consult')`, [ids.appointment, accountA, ids.contact, ids.service, ids.staff, ids.location]);
    await owner.query(`INSERT INTO meeting_connections(id,account_id,zoom_account_id,authorized_zoom_user_id,access_token_enc,refresh_token_enc,
        token_expires_at) VALUES($1,$2,$3,'zuser1','enc-a','enc-r',now()+interval '1 hour')`, [ids.meetingConn, accountA, zoomAccount]);
    await owner.query(`INSERT INTO appointment_meetings(id,account_id,appointment_id,connection_id,meeting_ref,registrant_id,claim_token,sync_state)
      VALUES($1,$2,$3,$4,'abcdefghij','reg-1',gen_random_uuid(),'unknown')`, [ids.meeting, accountA, ids.appointment, ids.meetingConn]);
    await owner.query(`INSERT INTO courier_connections(id,account_id,api_email,api_password_enc,token_enc,webhook_token_hash)
      VALUES($1,$2,'api@example.invalid','enc-p','enc-t',repeat('a',64))`, [ids.courierConn, accountA]);
    await owner.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
        tax_inclusive,total_minor,status,priced_at,amount_paid_minor,paid_at,marketing_opt_in,marketing_opt_in_at,marketing_opt_in_version)
      VALUES($1,$2,'storefront',$3,'INR',10000,0,0,0,true,10000,'paid',now(),10000,now(),true,now(),'reorder_v1')`, [ids.order, accountA, ids.contact]);
    await owner.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
        tax_inclusive,total_minor,status) VALUES($1,$2,'whatsapp',$3,'INR',10000,0,0,0,true,10000,'new')`, [ids.cartOrder, accountA, ids.contact]);
    await owner.query(`INSERT INTO order_shipments(id,account_id,order_id,connection_id,reference,claim_token,create_state,length_cm,breadth_cm,
        height_cm,weight_grams) VALUES($1,$2,$3,$4,'bxabcdefghijkl',gen_random_uuid(),'unknown',10,10,10,500)`,
      [ids.shipment, accountA, ids.order, ids.courierConn]);
    await owner.query(`INSERT INTO shipment_exceptions(id,account_id,shipment_id,kind) VALUES($1,$2,$3,'create_unknown')`,
      [ids.exception, accountA, ids.shipment]);
    await owner.query("INSERT INTO shop_products(id,account_id,name,status) VALUES($1,$2,'Triphala','draft')", [ids.product, accountA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('keeps secrets, claim tokens and registrant ids out of the app role', async () => {
    for (const [table, column] of [
      ['meeting_connections', 'access_token_enc'], ['meeting_connections', 'refresh_token_enc'], ['meeting_connections', 'zoom_account_id'],
      ['appointment_meetings', 'registrant_id'], ['appointment_meetings', 'claim_token'],
      ['courier_connections', 'api_password_enc'], ['courier_connections', 'token_enc'], ['courier_connections', 'webhook_token_hash'],
      ['order_shipments', 'claim_token'],
    ]) expect(await fails(app(asAdmin, `SELECT ${column} FROM ${table}`)), `${table}.${column}`).toBe(true);
    // The granted columns are readable by agents; the worker reads everything.
    expect(await app(asAgent, 'SELECT status, register_attendees FROM meeting_connections')).toEqual([{ status: 'active', register_attendees: false }]);
    expect(await app(asAgent, 'SELECT sync_state, meeting_ref FROM appointment_meetings')).toEqual([{ sync_state: 'unknown', meeting_ref: 'abcdefghij' }]);
    expect(await app(asAgent, 'SELECT api_email FROM courier_connections')).toEqual([{ api_email: 'api@example.invalid' }]);
    expect(await app(asAgent, 'SELECT reference, create_state FROM order_shipments')).toEqual([{ reference: 'bxabcdefghijkl', create_state: 'unknown' }]);
    expect(await worker(asWorkerA, 'SELECT access_token_enc FROM meeting_connections')).toEqual([{ access_token_enc: 'enc-a' }]);
    expect(await worker(asWorkerA, 'SELECT registrant_id FROM appointment_meetings')).toEqual([{ registrant_id: 'reg-1' }]);
  });

  it('shows viewers and other workspaces nothing new', async () => {
    for (const table of ['meeting_connections', 'appointment_meetings', 'meeting_participant_events', 'courier_connections', 'order_shipments',
      'shipment_tracking_events', 'shipment_exceptions', 'order_notice_templates']) {
      expect(await app(asViewer, `SELECT account_id FROM ${table}`), table).toEqual([]);
      expect(await app(asB, `SELECT account_id FROM ${table}`), table).toEqual([]);
    }
  });

  it('lets only the worker write evidence, meetings, shipments and exceptions', async () => {
    expect(await fails(app(asAdmin, `INSERT INTO meeting_participant_events(appointment_meeting_id,kind,event_at,receipt_key)
      VALUES($1::uuid,'participant_joined',now(),'r-app')`, ids.meeting))).toBe(true);
    expect(await fails(app(asAdmin, `INSERT INTO shipment_tracking_events(shipment_id,status,provider_code,event_at,source)
      VALUES($1::uuid,'delivered','7',now(),'refetch')`, ids.shipment))).toBe(true);
    expect(await fails(app(asAdmin, `INSERT INTO shipment_exceptions(shipment_id,kind) VALUES($1::uuid,'rto')`, ids.shipment))).toBe(true);
    expect(await fails(app(asAdmin, `UPDATE appointment_meetings SET sync_state='active' WHERE id=$1::uuid`, ids.meeting))).toBe(true);
    expect(await fails(app(asAdmin, `UPDATE order_shipments SET awb='AWB123' WHERE id=$1::uuid`, ids.shipment))).toBe(true);
    expect(await fails(app(asAdmin, `UPDATE meeting_connections SET status='disconnected' WHERE id=$1::uuid`, ids.meetingConn))).toBe(true);
    expect(await fails(app(asAdmin, `UPDATE courier_connections SET pickup_location='x' WHERE id=$1::uuid`, ids.courierConn))).toBe(true);
    expect(await fails(app(asAdmin, `INSERT INTO meeting_connections(zoom_account_id) VALUES('rogue')`))).toBe(true);
    // The worker writes evidence once per receipt.
    await worker(asWorkerA, `INSERT INTO meeting_participant_events(appointment_meeting_id,kind,participant_kind,event_at,receipt_key)
      VALUES($1::uuid,'participant_joined','guest',now(),$2)`, ids.meeting, `zoom:${ids.meeting}:1`);
    expect(await fails(worker(asWorkerA, `INSERT INTO meeting_participant_events(appointment_meeting_id,kind,event_at,receipt_key)
      VALUES($1::uuid,'participant_joined',now(),$2)`, ids.meeting, `zoom:${ids.meeting}:1`))).toBe(true);
    await worker(asWorkerA, `INSERT INTO shipment_tracking_events(shipment_id,status,provider_code,event_at,source)
      VALUES($1::uuid,'in_transit','18','2026-11-01T10:00:00Z','refetch') ON CONFLICT DO NOTHING`, ids.shipment);
    await worker(asWorkerA, `INSERT INTO shipment_tracking_events(shipment_id,status,provider_code,event_at,source)
      VALUES($1::uuid,'in_transit','18','2026-11-01T10:00:00Z','poll') ON CONFLICT DO NOTHING`, ids.shipment);
    expect(await worker(asWorkerA, 'SELECT count(*)::int AS n FROM shipment_tracking_events')).toEqual([{ n: 1 }]);
  });

  it('lets admins (only) change the registration switch, host emails and resolve exceptions', async () => {
    expect(await fails(app(asAgent, `UPDATE meeting_connections SET register_attendees=true WHERE id=$1::uuid RETURNING id`, ids.meetingConn)
      .then((rows) => { if (!rows.length) throw new Error('no row'); }))).toBe(true);
    expect(await app(asAdmin, `UPDATE meeting_connections SET register_attendees=true WHERE id=$1::uuid RETURNING register_attendees`, ids.meetingConn))
      .toEqual([{ register_attendees: true }]);
    expect(await fails(app(asAgent, `UPDATE appointment_staff SET meeting_host_email='dr@example.invalid' WHERE id=$1::uuid RETURNING id`, ids.staff)
      .then((rows) => { if (!rows.length) throw new Error('no row'); }))).toBe(true);
    expect(await app(asAdmin, `UPDATE appointment_staff SET meeting_host_email='dr@example.invalid' WHERE id=$1::uuid RETURNING meeting_host_email`, ids.staff))
      .toEqual([{ meeting_host_email: 'dr@example.invalid' }]);
    expect(await fails(app(asAdmin, `UPDATE appointment_staff SET meeting_host_email='not-an-email' WHERE id=$1::uuid`, ids.staff))).toBe(true);
    expect(await fails(app(asAgent, `UPDATE shipment_exceptions SET status='resolved', resolution='dismiss' WHERE id=$1::uuid RETURNING id`, ids.exception)
      .then((rows) => { if (!rows.length) throw new Error('no row'); }))).toBe(true);
    expect(await fails(app(asAdmin, `UPDATE shipment_exceptions SET kind='rto' WHERE id=$1::uuid`, ids.exception))).toBe(true);
    // An open exception must not carry a resolution, and a resolved one must.
    expect(await fails(app(asAdmin, `UPDATE shipment_exceptions SET status='resolved' WHERE id=$1::uuid`, ids.exception))).toBe(true);
    expect(await app(asAdmin, `UPDATE shipment_exceptions SET status='resolved', resolution='dismiss', resolved_by=$2::uuid, resolved_at=now()
      WHERE id=$1::uuid RETURNING status`, ids.exception, ownerA)).toEqual([{ status: 'resolved' }]);
    // Notice templates: admins write, agents read.
    await app(asAdmin, `INSERT INTO order_notice_templates(kind,template_name,language) VALUES('repeat_purchase','reorder','en')`);
    expect(await fails(app(asAgent, `INSERT INTO order_notice_templates(kind,template_name,language) VALUES('feedback','fb','en')`))).toBe(true);
    expect(await app(asAgent, 'SELECT kind FROM order_notice_templates')).toEqual([{ kind: 'repeat_purchase' }]);
    expect(await fails(app(asAdmin, `INSERT INTO order_notice_templates(kind,template_name,language) VALUES('receipt','r','en')`))).toBe(true);
    // Reorder reminder days: admins, 1..365.
    expect(await app(asAdmin, `UPDATE shop_products SET repurchase_after_days=30 WHERE id=$1::uuid RETURNING repurchase_after_days`, ids.product))
      .toEqual([{ repurchase_after_days: 30 }]);
    expect(await fails(app(asAdmin, `UPDATE shop_products SET repurchase_after_days=0 WHERE id=$1::uuid`, ids.product))).toBe(true);
  });

  it('runs the definers for the worker only, and one live workspace per Zoom account', async () => {
    expect(await fails(app(asAdmin, 'SELECT * FROM crm_resolve_zoom_connection($1)', zoomAccount))).toBe(true);
    expect(await fails(app(asAdmin, 'SELECT * FROM crm_accounts_for_fulfilment_sweep()'))).toBe(true);
    const resolved = await getWorkerPrisma().$queryRaw<{ account_id: string; connection_id: string }[]>`
      SELECT account_id::text AS account_id, connection_id::text AS connection_id FROM crm_resolve_zoom_connection(${zoomAccount})`;
    expect(resolved).toEqual([{ account_id: accountA, connection_id: ids.meetingConn }]);
    const swept = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text AS account_id FROM crm_accounts_for_fulfilment_sweep()`;
    expect(swept.map((r) => r.account_id)).toContain(accountA);
    expect(swept.map((r) => r.account_id)).not.toContain(accountB);
    // Workspace B cannot connect the same Zoom account while A's connection is live.
    expect(await fails(worker({ accountId: accountB, role: 'owner' },
      `INSERT INTO meeting_connections(zoom_account_id) VALUES($1)`, zoomAccount))).toBe(true);
    // Nor can A hold two live connections.
    expect(await fails(worker(asWorkerA, `INSERT INTO meeting_connections(zoom_account_id) VALUES('other_acct')`))).toBe(true);
    // A disconnected connection resolves nothing and frees the Zoom account.
    await worker(asWorkerA, `UPDATE meeting_connections SET status='disconnected', disconnected_at=now(), access_token_enc=NULL,
      refresh_token_enc=NULL WHERE id=$1::uuid`, ids.meetingConn);
    expect(await getWorkerPrisma().$queryRaw<unknown[]>`SELECT * FROM crm_resolve_zoom_connection(${zoomAccount})`).toEqual([]);
    await worker({ accountId: accountB, role: 'owner' }, `INSERT INTO meeting_connections(zoom_account_id) VALUES($1)`, zoomAccount);
    // Shipments: one live shipment per order, and an AWB belongs to one shipment.
    expect(await fails(worker(asWorkerA, `INSERT INTO order_shipments(order_id,connection_id,reference,length_cm,breadth_cm,height_cm,weight_grams)
      VALUES($1::uuid,$2::uuid,'bxzzzzzzzzzzzz',1,1,1,1)`, ids.order, ids.courierConn))).toBe(true);
    expect(await fails(worker(asWorkerA, `UPDATE order_shipments SET reference='BX-not-ours' WHERE id=$1::uuid`, ids.shipment))).toBe(true);
  });

  it('widens the appointment, task and order-message CHECKs and keeps one open meeting task', async () => {
    await worker(asWorkerA, `INSERT INTO appointment_events(appointment_id,version,kind,actor) VALUES($1::uuid,1,'meeting_created','system')`, ids.appointment);
    expect(await fails(worker(asWorkerA, `INSERT INTO appointment_events(appointment_id,version,kind,actor) VALUES($1::uuid,1,'meeting_bogus','system')`,
      ids.appointment))).toBe(true);
    const task = `INSERT INTO tasks(appointment_id,kind,title) VALUES($1::uuid,'meeting_outcome','Record the outcome')
      ON CONFLICT (account_id, appointment_id, kind) WHERE status='open' AND kind IN ('meeting_sync','meeting_outcome') DO NOTHING RETURNING id`;
    expect(await worker(asWorkerA, task, ids.appointment)).toHaveLength(1);
    expect(await worker(asWorkerA, task, ids.appointment)).toHaveLength(0);
    // Manual tasks are not limited.
    await app(asAgent, `INSERT INTO tasks(appointment_id,kind,title) VALUES($1::uuid,'manual','a'),($1::uuid,'manual','b')`, ids.appointment);
    await worker(asWorkerA, `INSERT INTO order_messages(order_id,kind,status) VALUES($1::uuid,'repeat_purchase','skipped')`, ids.order);
    expect(await fails(worker(asWorkerA, `INSERT INTO order_messages(order_id,kind,status) VALUES($1::uuid,'bogus','skipped')`, ids.order))).toBe(true);
  });

  it('freezes the marketing opt-in once an order is priced, but lets the pricing update set it', async () => {
    expect(await fails(worker(asWorkerA, `UPDATE orders SET marketing_opt_in=false WHERE id=$1::uuid`, ids.order))).toBe(true);
    expect(await fails(worker(asWorkerA, `UPDATE orders SET marketing_opt_in_version='other' WHERE id=$1::uuid`, ids.order))).toBe(true);
    // The WhatsApp-cart path: opt-in and priced_at in one UPDATE (OLD.priced_at is NULL).
    await worker(asWorkerA, `UPDATE orders SET marketing_opt_in=true, marketing_opt_in_at=now(), marketing_opt_in_version='reorder_v1',
      priced_at=now(), status='awaiting_payment' WHERE id=$1::uuid`, ids.cartOrder);
    expect(await fails(worker(asWorkerA, `UPDATE orders SET marketing_opt_in=NULL WHERE id=$1::uuid`, ids.cartOrder))).toBe(true);
    // The wording key is a code, never free text.
    expect(await fails(worker(asWorkerA,
      `INSERT INTO orders(source,currency,subtotal_minor,marketing_opt_in_version) VALUES('manual','INR',1,'Bad Version')`))).toBe(true);
    // Other updates of a priced order still work.
    await worker(asWorkerA, `UPDATE orders SET note='packed' WHERE id=$1::uuid`, ids.order);
    // The app role cannot set consent at all.
    expect(await fails(app(asAdmin, `UPDATE orders SET marketing_opt_in=true WHERE id=$1::uuid`, ids.cartOrder))).toBe(true);
  });

  it('seeds the new plan features where appointments and the storefront are on', async () => {
    const plans = (await owner.query(`SELECT id, features FROM plans WHERE features ? 'appointments' OR features ? 'storefront'`)).rows as
      { id: string; features: Record<string, unknown> }[];
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      if ('appointments' in p.features) expect(p.features.online_meetings, p.id).toBe(p.features.appointments);
      if ('storefront' in p.features) expect(p.features.courier_shipping, p.id).toBe(p.features.storefront);
    }
  });
});
