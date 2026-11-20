import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { recordRefundRequested } from './connections';
import { dealOptions, moveDealOnCompleted, setAppointmentDeal, setCompletedDealStage } from './deals';
import { listSchedule } from './listing';

// Bookings and deals on PostgreSQL: tenancy (another workspace's deal, stage or
// refund is invisible), the customer rule, the completed-stage move rules,
// the refund record's idempotency and schedule paging.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const asA: TenantContext = { accountId: A, userId: ownerA, role: 'admin' };
const asB: TenantContext = { accountId: B, userId: ownerB, role: 'admin' };
const id = () => randomUUID();
const ids = {
  contact: id(), other: id(), contactB: id(), loc: id(), svc: id(), locB: id(), svcB: id(),
  pipe: id(), pipe2: id(), stNew: id(), stDone: id(), stOther: id(), pipeB: id(), stB: id(),
  deal: id(), dealOther: id(), dealWon: id(), dealB: id(),
  appt: id(), apptNoContact: id(), apptB: id(), payment: id(), refund: id(),
};
let db: pg.Client;

describe.skipIf(!ownerUrl || !appUrl)('appointment deals on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Deal test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    for (const [acc, own] of [[A, ownerA], [B, ownerB]]) {
      await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Deals',$2)", [acc, own]);
      await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [acc]);
      await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [acc, own]);
    }
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES ($1,$4,$5,'Asha','14155550101'),
      ($2,$4,$5,'Ravi','14155550102'),($3,$6,$7,'Other ws','14155550103')`, [ids.contact, ids.other, ids.contactB, A, ownerA, B, ownerB]);
    await db.query(`INSERT INTO pipelines(id,account_id,user_id,name) VALUES ($1,$4,$5,'Sales'),($2,$4,$5,'Other'),($3,$6,$7,'B')`,
      [ids.pipe, ids.pipe2, ids.pipeB, A, ownerA, B, ownerB]);
    await db.query(`INSERT INTO pipeline_stages(id,account_id,pipeline_id,name,position) VALUES
      ($1,$6,$7,'New',0),($2,$6,$7,'Done',1),($3,$6,$8,'Elsewhere',0),($4,$9,$5,'B stage',0)`,
      [ids.stNew, ids.stDone, ids.stOther, ids.stB, ids.pipeB, A, ids.pipe, ids.pipe2, B]);
    await db.query(`INSERT INTO deals(id,account_id,user_id,pipeline_id,stage_id,contact_id,title,status) VALUES
      ($1,$5,$6,$7,$8,$9,'Asha deal','open'),($2,$5,$6,$7,$8,$10,'Ravi deal','open'),
      ($3,$5,$6,$7,$8,$9,'Asha won','won'),($4,$11,$12,$13,$14,$15,'B deal','open')`,
      [ids.deal, ids.dealOther, ids.dealWon, ids.dealB, A, ownerA, ids.pipe, ids.stNew, ids.contact, ids.other, B, ownerB, ids.pipeB, ids.stB, ids.contactB]);
    for (const [acc, loc, svc] of [[A, ids.loc, ids.svc], [B, ids.locB, ids.svcB]]) {
      await db.query("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'L','UTC')", [loc, acc]);
      await db.query("INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes) VALUES($1,$2,'Consult','offline',30)", [svc, acc]);
    }
    const appt = (apptId: string, acc: string, loc: string, svc: string, contact: string | null, hour: number, status = 'confirmed') =>
      db.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,service_name,payment_status)
        VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz + interval '30 minutes','UTC',$7,'staff','Consult',$8)`,
        [apptId, acc, contact, svc, loc, new Date(Date.UTC(2026, 11, 1, hour)), status, status === 'cancelled' ? 'paid' : 'none']);
    await appt(ids.appt, A, ids.loc, ids.svc, ids.contact, 9);
    await appt(ids.apptNoContact, A, ids.loc, ids.svc, null, 10);
    await appt(ids.apptB, B, ids.locB, ids.svcB, ids.contactB, 9);
    for (let h = 11; h < 16; h++) await appt(randomUUID(), A, ids.loc, ids.svc, ids.contact, h, 'cancelled');
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('offers only the customer\'s own open deals in this workspace', async () => {
    const page = await withTenant(asA, (tx) => dealOptions(tx, A, ids.appt));
    expect(page.deals.map((d) => d.id)).toEqual([ids.deal]);
    const any = await withTenant(asA, (tx) => dealOptions(tx, A, ids.apptNoContact, { q: 'deal' }));
    expect(any.deals.map((d) => d.id).sort()).toEqual([ids.deal, ids.dealOther].sort());
    await expect(withTenant(asB, (tx) => dealOptions(tx, B, ids.appt))).rejects.toThrow('not_found');
  });

  it('links a deal with a history row, refuses another customer\'s or workspace\'s deal, and unlinks', async () => {
    await expect(withTenant(asA, (tx) => setAppointmentDeal(tx, { accountId: A, userId: ownerA, appointmentId: ids.appt, dealId: ids.dealOther })))
      .rejects.toThrow('invalid');
    await expect(withTenant(asA, (tx) => setAppointmentDeal(tx, { accountId: A, userId: ownerA, appointmentId: ids.appt, dealId: ids.dealB })))
      .rejects.toThrow('not_found');
    await expect(withTenant(asB, (tx) => setAppointmentDeal(tx, { accountId: B, userId: ownerB, appointmentId: ids.appt, dealId: ids.dealB })))
      .rejects.toThrow('not_found');
    const linked = await withTenant(asA, (tx) => setAppointmentDeal(tx, { accountId: A, userId: ownerA, appointmentId: ids.appt, dealId: ids.deal }));
    expect(linked.deal_id).toBe(ids.deal);
    await withTenant(asA, (tx) => setAppointmentDeal(tx, { accountId: A, userId: ownerA, appointmentId: ids.appt, dealId: ids.deal }));
    const events = await db.query("SELECT kind FROM appointment_events WHERE appointment_id=$1 AND kind LIKE 'deal_%'", [ids.appt]);
    expect(events.rows.map((r) => r.kind)).toEqual(['deal_linked']);
  });

  it('moves the deal on completion only to a stage of its own pipeline, only while open', async () => {
    const move = () => withTenant(asA, (tx) => moveDealOnCompleted(tx, { accountId: A, userId: ownerA,
      appointment: { id: ids.appt, status: 'completed', deal_id: ids.deal } }));
    expect(await move()).toBe(false); // no stage set
    await expect(withTenant(asA, (tx) => setCompletedDealStage(tx, A, ownerA, ids.stB))).rejects.toThrow('not_found');
    await withTenant(asA, (tx) => setCompletedDealStage(tx, A, ownerA, ids.stOther));
    expect(await move()).toBe(false); // other pipeline
    await withTenant(asA, (tx) => setCompletedDealStage(tx, A, ownerA, ids.stDone));
    expect(await withTenant(asA, (tx) => moveDealOnCompleted(tx, { accountId: A, userId: ownerA,
      appointment: { id: ids.appt, status: 'confirmed', deal_id: ids.deal } }))).toBe(false);
    expect(await move()).toBe(true);
    expect((await db.query('SELECT stage_id FROM deals WHERE id=$1', [ids.deal])).rows[0].stage_id).toBe(ids.stDone);
    expect(await withTenant(asA, (tx) => moveDealOnCompleted(tx, { accountId: A, userId: ownerA,
      appointment: { id: ids.appt, status: 'completed', deal_id: ids.dealWon } }))).toBe(false);
    expect((await db.query('SELECT stage_id FROM deals WHERE id=$1', [ids.dealWon])).rows[0].stage_id).toBe(ids.stNew);
  });

  it('records a refund request once, and only for this booking\'s own refund', async () => {
    const [cancelled] = (await db.query("SELECT id FROM appointments WHERE account_id=$1 AND status='cancelled' LIMIT 1", [A])).rows;
    await db.query(`INSERT INTO customer_payments(id,account_id,appointment_id,source,amount_minor,currency,status,settlement,offline_reference,method,recorded_by,captured_at)
      VALUES($1,$2,$3,'offline',50000,'INR','captured','settled','cash-1','cash',$4,now())`, [ids.payment, A, cancelled.id, ownerA]);
    await db.query(`INSERT INTO customer_refunds(id,account_id,payment_id,appointment_id,source,amount_minor,currency,reason_code,status,requested_by)
      VALUES($1,$2,$3,$4,'bodhinox',50000,'INR','customer_request','requested',$5)`, [ids.refund, A, ids.payment, cancelled.id, ownerA]);
    const record = (ctx: TenantContext, apptId: string) => withTenant(ctx, (tx) => recordRefundRequested(tx,
      { accountId: ctx.accountId, userId: ctx.userId as string, appointmentId: apptId, refundId: ids.refund }));
    await expect(record(asA, ids.appt)).rejects.toThrow('not_found');
    await expect(record(asB, ids.apptB)).rejects.toThrow('not_found');
    expect(await record(asA, cancelled.id)).toBe('recorded');
    expect(await record(asA, cancelled.id)).toBe('already');
  });

  it('pages the schedule by cursor without repeats and says when it was cut', async () => {
    const from = new Date('2026-12-01T00:00:00Z'), to = new Date('2026-12-02T00:00:00Z');
    const first = await withTenant(asA, (tx) => listSchedule(tx, A, { from, to, limit: 4 }));
    expect(first.rows).toHaveLength(4);
    expect(first.truncated).toBe(true);
    expect(first.rows[0].contact_name).toBe('Asha');
    const { decodeCursor } = await import('./listing');
    const second = await withTenant(asA, (tx) => listSchedule(tx, A, { from, to, limit: 4, cursor: decodeCursor(first.nextCursor) }));
    expect(second.rows).toHaveLength(3);
    expect(second.truncated).toBe(false);
    const all = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(7);
    expect(all).not.toContain(ids.apptB);
  });
});
