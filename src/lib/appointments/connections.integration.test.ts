import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { customerBookingContext } from './ai-context';
import { setHours, setOfferings } from './config';
import { contactBookings, contactBookingTimeline } from './contact-bookings';
import { searchAppointments } from './search';
import { bookingRevenue } from './stats';
import { isAppointmentError } from './types';

// WP-D2 connections on PostgreSQL: the contact card's bookings, booking
// revenue, the contact timeline, booking search and the AI booking context,
// each confined to the caller's workspace and contact.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'http://localhost:3000';
process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32);

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, viewerA, ownerB];
const asOwner: TenantContext = { accountId: A, userId: ownerA, role: 'owner' };
const asViewer: TenantContext = { accountId: A, userId: viewerA, role: 'viewer' };
const contactA = randomUUID(), otherA = randomUUID(), contactB = randomUUID();
const ids = {
  svc: randomUUID(), svcB: randomUUID(), loc: randomUUID(), locB: randomUUID(), staff: randomUUID(), page: randomUUID(),
  a1: randomUUID(), a2: randomUUID(), a3: randomUUID(), a4: randomUUID(), a5: randomUUID(), other: randomUUID(), b1: randomUUID(),
};
const DAY = 86_400_000;
const now = new Date();
const startIn = (days: number) => new Date(Math.floor((now.getTime() + days * DAY) / 3_600_000) * 3_600_000);
const day = (d: Date) => d.toISOString().slice(0, 10);
let db: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment connections on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Conn test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Conn A',$2),($3,'Conn B',$4)", [A, ownerA, B, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [A, B]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
      [A, ownerA, viewerA, B, ownerB]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES
      ($1,$4,$5,'Asha Rao','14155550101'),($2,$4,$5,'Ravi Kumar','14155550102'),($3,$6,$7,'Asha Elsewhere','14155550199')`,
    [contactA, otherA, contactB, A, ownerA, B, ownerB]);
    const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
    await withTenant(asOwner, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days) VALUES(0,60)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.loc}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.svc}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name) VALUES(${ids.staff}::uuid,'Dr One')`;
      for (const staff of [ids.staff, null]) await setHours(tx, A, ownerA, { location_id: ids.loc, staff_id: staff, hours: allDay });
      await setOfferings(tx, A, ownerA, { service_id: ids.svc, location_id: ids.loc, pooled: false, staff_ids: [ids.staff] });
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${`conn-${A.slice(0, 8)}`},'Book')`;
    });
    await withTenant({ accountId: B, userId: ownerB, role: 'owner' }, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.locB}::uuid,'Other','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.svcB}::uuid,'Consult','offline',30)`;
    });
    // Rows as the owner role: payment_status is worker-only for the app role.
    const insert = (id: string, account: string, contact: string, svc: string, loc: string, start: Date, status: string,
      extra: { paid?: [number, string]; refunded?: boolean; confirmed?: boolean } = {}) => db.query(`
      INSERT INTO appointments(id,account_id,contact_id,service_id,location_id,start_at,end_at,timezone,status,source,service_name,
        confirmed_at,price_minor,currency,payment_status)
      VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz + interval '30 minutes','Asia/Kolkata',$7,'staff','Consult',$8,$9,$10,$11)`,
    [id, account, contact, svc, loc, start, status, extra.confirmed === false ? null : start,
      extra.paid?.[0] ?? null, extra.paid?.[1] ?? null, extra.paid ? (extra.refunded ? 'refunded' : 'paid') : 'none']);
    await insert(ids.a1, A, contactA, ids.svc, ids.loc, startIn(2), 'confirmed', { paid: [50000, 'INR'] });
    await insert(ids.a2, A, contactA, ids.svc, ids.loc, startIn(3), 'confirmed');
    await insert(ids.a3, A, contactA, ids.svc, ids.loc, startIn(-2), 'completed', { paid: [20000, 'INR'] });
    await insert(ids.a4, A, contactA, ids.svc, ids.loc, startIn(-1), 'cancelled', { paid: [30000, 'INR'], refunded: true });
    await insert(ids.a5, A, contactA, ids.svc, ids.loc, startIn(4), 'cancelled', { confirmed: false });
    await insert(ids.other, A, otherA, ids.svc, ids.loc, startIn(1), 'confirmed');
    await insert(ids.b1, B, contactB, ids.svcB, ids.locB, startIn(1), 'confirmed', { paid: [90000, 'INR'] });
    await db.query(`INSERT INTO appointment_events(account_id,appointment_id,version,kind,actor) VALUES
      ($1,$2,1,'confirmed','staff'),($1,$3,1,'confirmed','staff'),($1,$3,2,'completed','staff'),
      ($1,$4,1,'confirmed','staff'),($1,$4,2,'cancelled','staff'),($1,$5,1,'held','customer'),($1,$5,2,'cancelled','system'),
      ($6,$7,1,'confirmed','staff')`, [A, ids.a1, ids.a3, ids.a4, ids.a5, B, ids.b1]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('contact card: upcoming soonest first, past latest first, keyset paged, only this contact', async () => {
    const upcoming = await withTenant(asViewer, (tx) => contactBookings(tx, A, contactA, { kind: 'upcoming', limit: 1 }));
    expect(upcoming.items.map((i) => i.id)).toEqual([ids.a1]);
    expect(upcoming.next).not.toBeNull();
    const second = await withTenant(asViewer, (tx) => contactBookings(tx, A, contactA, { kind: 'upcoming', limit: 1, cursor: upcoming.next }));
    expect(second).toMatchObject({ items: [{ id: ids.a2 }], next: null });
    const past = await withTenant(asViewer, (tx) => contactBookings(tx, A, contactA, { kind: 'past', limit: 10 }));
    // The cancelled future booking counts as past; the other contact's booking never shows.
    expect(past.items.map((i) => i.id)).toEqual([ids.a5, ids.a4, ids.a3]);
    expect(Object.keys(past.items[0]).sort()).toEqual(['end_at', 'id', 'payment_status', 'service_name', 'start_at', 'status', 'timezone']);
  });

  it('contact card: another workspace\'s contact is not found', async () => {
    const err = await withTenant(asViewer, (tx) => contactBookings(tx, A, contactB, { kind: 'upcoming' })).catch((e) => e);
    expect(isAppointmentError(err) && err.code).toBe('not_found');
  });

  it('booking revenue counts still-paid bookings of this workspace only', async () => {
    const rows = await withTenant(asViewer, (tx) => bookingRevenue(tx, A, { from: day(startIn(-6)), to: day(startIn(6)) }));
    expect(rows).toEqual([expect.objectContaining({ service_id: ids.svc, currency: 'INR', paid_bookings: 2 })]);
    expect(BigInt(rows[0].revenue_minor)).toBe(BigInt(70000));
  });

  it('timeline shows the contact\'s booking events and hides a never-confirmed cancelled hold', async () => {
    const rows = await withTenant(asViewer, (tx) => contactBookingTimeline(tx, A, contactA));
    const pairs = rows.map((r) => `${r.detail.appointment_id === ids.a5 ? 'a5' : 'x'}:${r.detail.event}`);
    expect(pairs.filter((p) => p.endsWith(':booked'))).toHaveLength(3);
    expect(pairs).toContain('x:completed');
    expect(pairs).toContain('x:cancelled');
    expect(pairs.some((p) => p.startsWith('a5'))).toBe(false);
  });

  it('search finds this workspace\'s bookings by contact name, upcoming first', async () => {
    const hits = await withTenant(asViewer, (tx) => searchAppointments(tx, A, 'asha', 10));
    expect(hits.map((h) => h.id)).toEqual([ids.a1, ids.a2, ids.a5, ids.a4, ids.a3]);
    expect(hits.map((h) => h.id)).not.toContain(ids.b1);
    expect(hits[0]).toMatchObject({ title: 'Asha Rao', subtitle: 'Consult', href: `/appointments?id=${ids.a1}` });
  });

  it('AI context: own next booking with manage link, free times and the booking page, bounded, no one else\'s data', async () => {
    const text = await withTenant(asOwner, (tx) => customerBookingContext(tx, A, contactA));
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(600);
    expect(text).toContain('Their next booking: Consult');
    expect(text).toContain('/my-booking/');
    expect(text).toContain('Free times for Consult');
    expect(text).toContain(`/book/conn-${A.slice(0, 8)}`);
    expect(text).not.toMatch(/Ravi|Elsewhere|1415555/);
    // Workspace B's own context: its booking, no bookable service and no page there.
    const other = await withTenant({ accountId: B, userId: ownerB, role: 'owner' }, (tx) => customerBookingContext(tx, B, contactB));
    expect(other).toContain('Their next booking');
    expect(other).not.toMatch(/Free times|Book online/);
    // Asked from workspace A's session, B's contact yields nothing (RLS).
    expect(await withTenant(asOwner, (tx) => customerBookingContext(tx, B, contactB))).toBeNull();
  });
});
