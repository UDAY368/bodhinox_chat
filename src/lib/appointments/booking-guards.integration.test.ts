import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { bookAppointment, MAX_ACTIVE_HOLDS_PER_CLIENT, rescheduleAppointment, type BookInput } from './booking';
import { createLocation, setHours, setOfferings } from './config';
import { lockKeys, sourceRefs } from './keys';
import { isAppointmentError } from './types';

// Review-round guards on PostgreSQL: page-wide serialisation of public holds,
// the per-client hold cap, the offering-shape lock, group seats per location,
// staff changes inside the notice window, notice payload times and location
// time zones that Postgres can read.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID();
const owner = randomUUID(), agent = randomUUID();
const users = [owner, agent];
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const contacts = Array.from({ length: 8 }, () => randomUUID());
const ids = {
  locA: randomUUID(), locB: randomUUID(), single: randomUUID(), group: randomUUID(), shape: randomUUID(),
  s1: randomUUID(), s2: randomUUID(), s3: randomUUID(), page: randomUUID(),
};
let db: pg.Client;

const worker = <T>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, work, getWorkerPrisma());
const staffBook = (input: Partial<BookInput> & Pick<BookInput, 'serviceId' | 'startAt'>) =>
  withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', locationId: ids.locA, contactId: contacts[0], ...input }));
const hold = (startAt: Date, over: Partial<BookInput> = {}) => worker((tx) => bookAppointment(tx, {
  accountId: account, source: 'public', serviceId: ids.single, locationId: ids.locA, startAt, bookingPageId: ids.page,
  sourceRef: sourceRefs.public(ids.page, randomUUID()), ...over }));
const setPageCap = (n: number) => db.query('UPDATE appointment_settings SET max_active_holds_per_page=$2 WHERE account_id=$1', [account, n]);
const clearHolds = () => db.query(`UPDATE appointments SET status='expired', hold_client_hash=NULL WHERE account_id=$1 AND status='held'`, [account]);
const at = (iso: string) => new Date(iso);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment booking guards on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Guard test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Booking guards',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent')`, [account, owner, agent]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Contact ' || n, '1415666' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days,max_active_holds_per_page) VALUES(0,365,1)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.locA}::uuid,'A','Asia/Kolkata'),(${ids.locB}::uuid,'B','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.single}::uuid,'Consult','offline',30),
        (${ids.shape}::uuid,'Shape','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,capacity) VALUES(${ids.group}::uuid,'Yoga','offline',60,3)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name) VALUES(${ids.s1}::uuid,'One'),(${ids.s2}::uuid,'Two'),(${ids.s3}::uuid,'Three')`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      for (const location of [ids.locA, ids.locB])
        for (const staff of [ids.s1, ids.s2, ids.s3, null]) await setHours(tx, account, owner, { location_id: location, staff_id: staff, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.single, location_id: ids.locA, pooled: false, staff_ids: [ids.s1, ids.s2, ids.s3] });
      await setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: false, staff_ids: [ids.s1] });
      for (const location of [ids.locA, ids.locB])
        await setOfferings(tx, account, owner, { service_id: ids.group, location_id: location, pooled: false, staff_ids: [ids.s1] });
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${`grd-${account.slice(0, 8)}`},'Book')`;
      await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${ids.page}::uuid,${ids.single}::uuid)`;
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('concurrent public holds on different practitioners cannot pass the page cap together', async () => {
    await setPageCap(1);
    const starts = ['2026-12-01T05:30:00Z', '2026-12-01T06:30:00Z'];
    const results = await Promise.allSettled([ids.s1, ids.s2, ids.s3].flatMap((staffId) => starts.map((s) => hold(at(s), { staffId }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const active = await db.query(`SELECT count(*)::int AS n FROM appointments WHERE account_id=$1 AND booking_page_id=$2 AND status='held'`,
      [account, ids.page]);
    expect(active.rows[0].n).toBe(1);
    await clearHolds();
  });

  it('one client keeps only a few holds; another client can still hold', async () => {
    await setPageCap(20);
    const mine = randomBytes(32).toString('hex'), theirs = randomBytes(32).toString('hex');
    for (let i = 0; i < MAX_ACTIVE_HOLDS_PER_CLIENT; i++) await hold(at(`2026-12-02T0${5 + i}:30:00Z`), { clientHash: mine });
    await expect(hold(at('2026-12-02T09:30:00Z'), { clientHash: mine })).rejects.toMatchObject({ code: 'too_many' });
    const other = await hold(at('2026-12-02T09:30:00Z'), { clientHash: theirs });
    expect(other.appointment.status).toBe('held');
    const stored = (await db.query('SELECT hold_client_hash FROM appointments WHERE id=$1', [other.appointment.id])).rows[0];
    expect(stored.hold_client_hash).toBe(theirs);
    await expect(staffBook({ serviceId: ids.single, startAt: at('2026-12-02T10:30:00Z'), clientHash: mine })).rejects.toMatchObject({ code: 'invalid' });
    await clearHolds();
  });

  it('a booking waiting on the offering lock sees a pooled/staffed switch and refuses', async () => {
    const blocker = new pg.Client({ connectionString: ownerUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKeys.config(account, ids.shape, ids.locA)]);
      const pending = staffBook({ serviceId: ids.shape, staffId: ids.s1, startAt: at('2026-12-03T05:30:00Z'), contactId: contacts[1] });
      const settled = pending.then(() => 'ok', (e) => (isAppointmentError(e) ? e.code : String(e)));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await blocker.query('DELETE FROM appointment_offerings WHERE account_id=$1 AND service_id=$2 AND location_id=$3', [account, ids.shape, ids.locA]);
      await blocker.query('INSERT INTO appointment_offerings(account_id,service_id,staff_id,location_id) VALUES($1,$2,NULL,$3)', [account, ids.shape, ids.locA]);
      await blocker.query('COMMIT');
      expect(await settled).toBe('slot_unavailable');
    } finally {
      await blocker.end();
    }
    await withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: false, staff_ids: [ids.s1] }));
  });

  it('refuses a pooled/staffed switch while the current shape has active future bookings', async () => {
    const { appointment } = await staffBook({ serviceId: ids.shape, staffId: ids.s1, startAt: at('2026-12-03T07:30:00Z'), contactId: contacts[2] });
    await expect(withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: true })))
      .rejects.toMatchObject({ field: 'pooled', detail: 'mode_in_use' });
    // Clearing the offerings first does not get around it.
    await withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: false, staff_ids: [] }));
    await expect(withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: true })))
      .rejects.toMatchObject({ detail: 'mode_in_use' });
    await db.query(`UPDATE appointments SET status='cancelled' WHERE id=$1`, [appointment.id]);
    await withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, { service_id: ids.shape, location_id: ids.locA, pooled: true }));
  });

  it('one practitioner running a group service at two locations is not booked into both at once', async () => {
    const startAt = at('2026-12-04T05:30:00Z');
    await staffBook({ serviceId: ids.group, locationId: ids.locA, staffId: ids.s1, startAt, contactId: contacts[3] });
    await expect(staffBook({ serviceId: ids.group, locationId: ids.locB, staffId: ids.s1, startAt, contactId: contacts[4] }))
      .rejects.toMatchObject({ code: 'slot_unavailable' });
    const seat = await staffBook({ serviceId: ids.group, locationId: ids.locA, staffId: ids.s1, startAt, contactId: contacts[5] });
    expect(seat.appointment.status).toBe('confirmed');
  });

  it('staff can reassign inside the notice window; the notice payload keeps the time it announces', async () => {
    await db.query('UPDATE appointment_settings SET min_notice_minutes=60 WHERE account_id=$1', [account]);
    try {
      const id = randomUUID();
      // The next half-hour grid start at least 5 minutes away: inside the 60-minute notice window.
      const soon = new Date(Math.ceil((Date.now() + 5 * 60_000) / 1_800_000) * 1_800_000);
      await db.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,
        confirmed_at,service_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Asia/Kolkata','confirmed','staff',now(),'Consult')`,
      [id, account, contacts[6], ids.single, ids.s1, ids.locA, soon, new Date(soon.getTime() + 30 * 60_000)]);
      const moved = await withTenant(asAgent, (tx) => rescheduleAppointment(tx, { accountId: account, appointmentId: id, startAt: soon,
        staffId: ids.s2, expectedVersion: 1, actor: 'staff', actorUserId: agent }));
      expect(moved).toMatchObject({ staff_id: ids.s2, version: 2 });
    } finally {
      await db.query('UPDATE appointment_settings SET min_notice_minutes=0 WHERE account_id=$1', [account]);
    }
    const startAt = at('2026-12-05T05:30:00Z');
    const { appointment } = await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt, contactId: contacts[7] });
    await withTenant(asAgent, (tx) => rescheduleAppointment(tx, { accountId: account, appointmentId: appointment.id, startAt,
      staffId: ids.s3, expectedVersion: 1, actor: 'staff' }));
    const [job] = (await db.query('SELECT payload FROM jobs WHERE dedupe_key=$1', [`appt-ntf:${appointment.id}:v1:confirmation`])).rows;
    expect(job.payload).toMatchObject({ version: 1, kind: 'confirmation', startAt: startAt.toISOString() });
  });

  it('stores a location zone Postgres reads the same way, and refuses offset forms', async () => {
    await expect(withTenant(asAdmin, (tx) => createLocation(tx, account, owner, { name: 'Offset', timezone: '+05:30' })))
      .rejects.toMatchObject({ field: 'timezone' });
    const alias = await withTenant(asAdmin, (tx) => createLocation(tx, account, owner, { name: 'Alias', timezone: 'US/Pacific-New' }));
    expect(['US/Pacific-New', 'America/Los_Angeles']).toContain(alias.timezone);
    expect((await db.query('SELECT count(*)::int AS n FROM pg_timezone_names WHERE name=$1', [alias.timezone])).rows[0].n).toBe(1);
    const lower = await withTenant(asAdmin, (tx) => createLocation(tx, account, owner, { name: 'Lower', timezone: 'america/new_york' }));
    expect(lower.timezone).toBe('America/New_York');
  });
});
