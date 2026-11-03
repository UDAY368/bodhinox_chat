import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { setHours, setOfferings } from '@/lib/appointments/config';
import {
  appointmentLocation, appointmentServices, appointmentSlots, appointmentStaff, bookFlowAppointment,
} from './appointment-runtime';

// The book_appointment flow step's data access on PostgreSQL: which services
// and locations it offers, the practitioner list, and that a flow booking is
// confirmed, idempotent per run transition and respects the Monday rule.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID();
const other = randomUUID();
const owner = randomUUID();
const contact = randomUUID();
const ids = {
  clinic: randomUUID(), closed: randomUUID(), online: randomUUID(), staffed: randomUUID(), monday: randomUUID(),
  archived: randomUUID(), orphan: randomUUID(), s1: randomUUID(), s2: randomUUID(),
};
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
let db: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('book_appointment flow data on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1::uuid,$2,'Flow booking test','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Flow booking A',$3),($2,'Flow booking B',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Flow customer','14155550199')", [contact, account, owner]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days) VALUES(0,365)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.clinic}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone,archived_at) VALUES(${ids.closed}::uuid,'Aardvark closed','Asia/Kolkata',now())`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,meeting_url) VALUES(${ids.online}::uuid,'Video call','online',30,'https://meet.example.invalid/x')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.staffed}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,allowed_weekdays) VALUES(${ids.monday}::uuid,'Free consult','offline',30,'{1}')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,archived_at) VALUES(${ids.archived}::uuid,'Archived','offline',30,now())`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.orphan}::uuid,'No offering','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name) VALUES(${ids.s1}::uuid,'Dr Zed'),(${ids.s2}::uuid,'Dr Amar')`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]));
      for (const staff of [ids.s1, ids.s2, null]) await setHours(tx, account, owner, { location_id: ids.clinic, staff_id: staff, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.online, location_id: ids.clinic, pooled: true });
      await setOfferings(tx, account, owner, { service_id: ids.staffed, location_id: ids.clinic, pooled: false, staff_ids: [ids.s1, ids.s2] });
      await setOfferings(tx, account, owner, { service_id: ids.monday, location_id: ids.clinic, pooled: false, staff_ids: [ids.s1] });
      await setOfferings(tx, account, owner, { service_id: ids.archived, location_id: ids.clinic, pooled: true });
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('offers only live, bookable services, filtered by ids and mode, and nothing to another tenant', async () => {
    expect((await appointmentServices(account, {})).map((s) => s.name)).toEqual(['Consult', 'Free consult', 'Video call']);
    expect((await appointmentServices(account, { service_mode: 'online' })).map((s) => s.id)).toEqual([ids.online]);
    expect((await appointmentServices(account, { service_ids: [ids.monday, ids.archived, ids.orphan] })).map((s) => s.id)).toEqual([ids.monday]);
    expect(await appointmentServices(account, { location_id: ids.closed })).toEqual([]);
    expect(await appointmentServices(other, {})).toEqual([]);
  });

  it('picks a live location and lists practitioners by name (none for a pool)', async () => {
    expect(await appointmentLocation(account, ids.staffed)).toBe(ids.clinic);
    expect(await appointmentLocation(account, ids.staffed, ids.closed)).toBeNull();
    expect(await appointmentLocation(other, ids.staffed)).toBeNull();
    expect((await appointmentStaff(account, ids.staffed, ids.clinic)).map((s) => s.name)).toEqual(['Dr Amar', 'Dr Zed']);
    expect(await appointmentStaff(account, ids.online, ids.clinic)).toEqual([]);
    expect(await appointmentStaff(account, ids.staffed, ids.closed)).toEqual([]);
  });

  it('lists only Mondays for a Monday-only service, in the clinic zone', async () => {
    const slots = await appointmentSlots(account, { serviceId: ids.monday, locationId: ids.clinic, days: 14 });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(new Date(`${s.localDate}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(slots[0].hhmm >= '09:00').toBe(true);
  });

  it('books a confirmed flow appointment once per run transition and refuses a non-Monday', async () => {
    const [slot] = await appointmentSlots(account, { serviceId: ids.monday, locationId: ids.clinic, days: 14 });
    const input = { runId: randomUUID(), nodeKey: 'book', transitionSeq: 3, contactId: contact, serviceId: ids.monday, locationId: ids.clinic, startAt: new Date(slot.startAt) };
    const first = await bookFlowAppointment(account, input);
    expect(first).toMatchObject({ ok: true, replayed: false, localTime: `${slot.localDate} ${slot.hhmm}` });
    const again = await bookFlowAppointment(account, input);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.ok && first.ok && again.appointmentId === first.appointmentId).toBe(true);
    const row = (await db.query('SELECT status, source, source_ref, contact_id FROM appointments WHERE id=$1', [first.ok ? first.appointmentId : null])).rows[0];
    expect(row).toMatchObject({ status: 'confirmed', source: 'flow', source_ref: `flow:${input.runId}:book:3`, contact_id: contact });
    // Another transition is a new booking attempt, not a replay: the one practitioner is now taken.
    expect(await bookFlowAppointment(account, { ...input, transitionSeq: 4 })).toEqual({ ok: false, code: 'slot_unavailable' });
    // A Tuesday start for the Monday-only service is not a bookable slot.
    const tuesday = new Date(new Date(slot.startAt).getTime() + 86_400_000);
    expect(await bookFlowAppointment(account, { ...input, runId: randomUUID(), startAt: tuesday })).toMatchObject({ ok: false });
  });
});
