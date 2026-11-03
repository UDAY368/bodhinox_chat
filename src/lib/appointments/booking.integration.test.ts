import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import {
  bookAppointment, cancelAppointment, confirmHold, expireHold, markOutcome, rescheduleAppointment, type BookInput,
} from './booking';
import { setHours, setOfferings } from './config';
import { listSlots } from './availability';
import { sourceRefs } from './keys';
import { isAppointmentError } from './types';

// Phase 7 completion gate on PostgreSQL: concurrent requests cannot overbook,
// cancel/reschedule leaves the old version's jobs obsolete, and the timezone
// and Monday rules survive date boundaries.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID();
const owner = randomUUID(), agent = randomUUID(), viewer = randomUUID();
const users = [owner, agent, viewer];
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const asViewer: TenantContext = { accountId: account, userId: viewer, role: 'viewer' };
const contacts = Array.from({ length: 24 }, () => randomUUID());
const ids = {
  location: randomUUID(), single: randomUUID(), monday: randomUUID(), group: randomUUID(), cfg: randomUUID(),
  s1: randomUUID(), s2: randomUUID(), page: randomUUID(),
};
let db: pg.Client;

const worker = <T>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, work, getWorkerPrisma());
const staffBook = (input: Partial<BookInput> & Pick<BookInput, 'serviceId' | 'startAt'>, ctx: TenantContext = asAgent) =>
  withTenant(ctx, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', locationId: ids.location, contactId: contacts[0], ...input }));
const codeOf = (error: unknown) => (isAppointmentError(error) ? error.code : (error as Error)?.message ?? String(error));
const activeAt = async (serviceId: string, startAt: Date) => Number((await db.query(
  `SELECT count(*) FROM appointments WHERE account_id=$1 AND service_id=$2 AND start_at=$3 AND status IN ('held','confirmed')`,
  [account, serviceId, startAt])).rows[0].count);
/** Next week's Monday-based instants keep every test inside the 365-day horizon and away from "now". */
const at = (iso: string) => new Date(iso);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment booking on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Booking test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Booking A',$2)", [account, owner]);
    // On a seeded plan that includes appointments (free/basic/pro carry the feature).
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer')`, [account, owner, agent, viewer]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, CASE WHEN n=1 THEN NULL ELSE 'Contact ' || n END, '1415555' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`,
    [contacts, account, owner]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days,max_active_holds_per_page) VALUES(0,365,3)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.single}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,allowed_weekdays) VALUES(${ids.monday}::uuid,'Free consult','offline',30,'{1}')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,capacity) VALUES(${ids.group}::uuid,'Group','offline',60,3)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.cfg}::uuid,'Config','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.s1}::uuid,'Dr One',${agent}::uuid),(${ids.s2}::uuid,'Dr Two',NULL)`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      for (const staff of [ids.s1, ids.s2, null]) await setHours(tx, account, owner, { location_id: ids.location, staff_id: staff, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.single, location_id: ids.location, pooled: false, staff_ids: [ids.s1, ids.s2] });
      await setOfferings(tx, account, owner, { service_id: ids.monday, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
      await setOfferings(tx, account, owner, { service_id: ids.group, location_id: ids.location, pooled: true });
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${`book-${account.slice(0, 8)}`},'Book')`;
      await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${ids.page}::uuid,${ids.single}::uuid),(${ids.page}::uuid,${ids.monday}::uuid)`;
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

  it('20 concurrent bookings of one capacity-1 practitioner slot leave exactly one active row', async () => {
    const startAt = at('2026-12-01T05:30:00Z');
    const results = await Promise.allSettled(contacts.slice(0, 20).map((contactId) =>
      staffBook({ serviceId: ids.single, staffId: ids.s1, startAt, contactId })));
    expect(await activeAt(ids.single, startAt)).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') {
      // Typed refusals; pool waits may surface as retriable errors, never as extra rows.
      expect(isAppointmentError(r.reason) ? ['slot_unavailable', 'customer_conflict'] : ['retriable'],
        codeOf(r.reason)).toContain(isAppointmentError(r.reason) ? r.reason.code : 'retriable');
    }
  });

  it('a capacity-3 group session takes exactly three', async () => {
    const startAt = at('2026-12-01T08:30:00Z');
    const results = await Promise.allSettled(contacts.slice(0, 8).map((contactId) => staffBook({ serviceId: ids.group, startAt, contactId })));
    expect(await activeAt(ids.group, startAt)).toBe(3);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  });

  it('"any practitioner" picks a free one, and the same contact cannot be in two places at once', async () => {
    const startAt = at('2026-12-02T05:30:00Z');
    const results = await Promise.allSettled([ids.s1, ids.s2].map((staffId) => staffBook({ serviceId: ids.single, staffId, startAt, contactId: contacts[21] })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.map((r) => (r.status === 'rejected' ? codeOf(r.reason) : 'ok')).sort()).toEqual(['customer_conflict', 'ok']);
    const other = await staffBook({ serviceId: ids.single, startAt, contactId: contacts[22] });
    expect(other.appointment.staff_id).not.toBeNull();
    await expect(staffBook({ serviceId: ids.single, startAt, contactId: contacts[23] })).rejects.toMatchObject({ code: 'slot_unavailable' });
  });

  it('pool and staffed offerings cannot coexist for one service and location', async () => {
    const pooled = (staff: string[] | null) => withTenant(asAdmin, (tx) => setOfferings(tx, account, owner, staff
      ? { service_id: ids.cfg, location_id: ids.location, pooled: false, staff_ids: staff }
      : { service_id: ids.cfg, location_id: ids.location, pooled: true }));
    await Promise.allSettled([pooled(null), pooled([ids.s1, ids.s2]), pooled(null), pooled([ids.s2])]);
    const rows = (await db.query('SELECT staff_id FROM appointment_offerings WHERE account_id=$1 AND service_id=$2', [account, ids.cfg])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.staff_id === null) || rows.every((r) => r.staff_id !== null)).toBe(true);
    await expect(withTenant(asAdmin, (tx) => setOfferings(tx, account, owner,
      { service_id: ids.cfg, location_id: ids.location, pooled: true, staff_ids: [ids.s1] }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(withTenant(asAgent, (tx) => setOfferings(tx, account, agent, { service_id: ids.cfg, location_id: ids.location, pooled: true })))
      .rejects.toBeTruthy();
  });

  it('crossed reschedules finish without deadlock, and a reschedule frees the old slot', async () => {
    const a = (await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-03T05:30:00Z'), contactId: contacts[2] })).appointment;
    const b = (await staffBook({ serviceId: ids.single, staffId: ids.s2, startAt: at('2026-12-03T06:30:00Z'), contactId: contacts[3] })).appointment;
    const move = (id: string, staffId: string, startAt: Date) => withTenant(asAgent, (tx) => rescheduleAppointment(tx,
      { accountId: account, appointmentId: id, startAt, staffId, expectedVersion: 1, actor: 'staff', actorUserId: agent }));
    const results = await Promise.allSettled([move(a.id, ids.s2, at('2026-12-03T07:30:00Z')), move(b.id, ids.s1, at('2026-12-03T08:30:00Z'))]);
    for (const r of results) expect(r.status === 'fulfilled' || !/deadlock/i.test(String((r as PromiseRejectedResult).reason))).toBe(true);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const freed = await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-03T05:30:00Z'), contactId: contacts[4] });
    expect(freed.appointment.status).toBe('confirmed');
    const history = (await db.query(`SELECT kind, old_start_at, new_start_at FROM appointment_events WHERE appointment_id=$1 AND kind='rescheduled'`, [a.id])).rows;
    expect(history).toEqual([{ kind: 'rescheduled', old_start_at: at('2026-12-03T05:30:00Z'), new_start_at: at('2026-12-03T07:30:00Z') }]);
  });

  it('a reschedule versions every job: old reminders keep the old version, new ones are queued, a stale version is a conflict', async () => {
    const { appointment } = await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-04T05:30:00Z'), contactId: contacts[5] });
    const jobs = async () => (await db.query(`SELECT dedupe_key, run_at FROM jobs WHERE tenant_id=$1 AND payload->>'appointmentId'=$2 ORDER BY dedupe_key`,
      [account, appointment.id])).rows.map((r) => r.dedupe_key);
    expect(await jobs()).toEqual([`appt-evt:${appointment.id}:v1:confirmed`, `appt-ntf:${appointment.id}:v1:confirmation`,
      `appt-rem:${appointment.id}:v1:24h`, `appt-rem:${appointment.id}:v1:2h`]);
    await withTenant(asAgent, (tx) => rescheduleAppointment(tx, { accountId: account, appointmentId: appointment.id,
      startAt: at('2026-12-04T09:30:00Z'), expectedVersion: 1, actor: 'staff' }));
    expect(await jobs()).toEqual(expect.arrayContaining([`appt-evt:${appointment.id}:v2:rescheduled`, `appt-ntf:${appointment.id}:v2:rescheduled`,
      `appt-rem:${appointment.id}:v2:24h`, `appt-rem:${appointment.id}:v2:2h`]));
    const [row] = (await db.query('SELECT version, start_at FROM appointments WHERE id=$1', [appointment.id])).rows;
    expect(row).toEqual({ version: 2, start_at: at('2026-12-04T09:30:00Z') });
    await expect(withTenant(asAgent, (tx) => cancelAppointment(tx, { accountId: account, appointmentId: appointment.id, reason: 'staff',
      expectedVersion: 1, actor: 'staff' }))).rejects.toMatchObject({ code: 'conflict' });
    await withTenant(asAgent, (tx) => cancelAppointment(tx, { accountId: account, appointmentId: appointment.id, reason: 'staff',
      expectedVersion: 2, actor: 'staff' }));
    expect(await jobs()).toEqual(expect.arrayContaining([`appt-ntf:${appointment.id}:v3:cancelled`]));
    // Reassigning a practitioner at the same time is a new version too (new reminders, no customer notice).
    const { appointment: c } = await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-04T11:30:00Z'), contactId: contacts[6] });
    await withTenant(asAgent, (tx) => rescheduleAppointment(tx, { accountId: account, appointmentId: c.id, startAt: c.start_at,
      staffId: ids.s2, expectedVersion: 1, actor: 'staff' }));
    const cJobs = (await db.query(`SELECT dedupe_key FROM jobs WHERE payload->>'appointmentId'=$1`, [c.id])).rows.map((r) => r.dedupe_key);
    expect(cJobs).toEqual(expect.arrayContaining([`appt-evt:${c.id}:v2:reassigned`, `appt-rem:${c.id}:v2:2h`]));
    expect(cJobs).not.toContain(`appt-ntf:${c.id}:v2:rescheduled`);
  });

  it('public holds: confirm by WhatsApp code, expiry frees the slot, a late code wins only while the slot is free', async () => {
    const hold = (startAt: Date, requestId = randomUUID()) => worker((tx) => bookAppointment(tx, {
      accountId: account, source: 'public', serviceId: ids.single, locationId: ids.location, staffId: ids.s2, startAt,
      bookingPageId: ids.page, sourceRef: sourceRefs.public(ids.page, requestId), intake: { name: 'Asha', city: 'Pune' } }));
    // Confirm while held: the sender becomes the contact, intake is cleared, an empty contact name is filled.
    const first = (await hold(at('2026-12-05T05:30:00Z'))).appointment;
    expect(first).toMatchObject({ status: 'held', contact_id: null });
    expect(first.hold_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const confirmed = await worker((tx) => confirmHold(tx, { accountId: account, code: first.hold_code as string, contactId: contacts[0],
      messageAt: new Date(), whatsappConfigId: null }));
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.appointment).toMatchObject({ status: 'confirmed', contact_id: contacts[0], version: 2 });
    const stored = (await db.query('SELECT intake, manage_token_hash FROM appointments WHERE id=$1', [first.id])).rows[0];
    expect(stored.intake).toBeNull();
    expect(stored.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.query('SELECT name FROM contacts WHERE id=$1', [contacts[0]])).rows[0].name).toBe('Asha');
    // A retried job is idempotent.
    expect((await worker((tx) => confirmHold(tx, { accountId: account, code: first.hold_code as string, contactId: contacts[0],
      messageAt: new Date(), whatsappConfigId: null }))).status).toBe('already_confirmed');

    // Expiry frees capacity.
    const late = (await hold(at('2026-12-05T07:30:00Z'))).appointment;
    const after = new Date(Date.now() + 30 * 60_000);
    expect(await worker((tx) => expireHold(tx, { accountId: account, appointmentId: late.id, version: 1 }))).toBe('skipped');
    expect(await worker((tx) => expireHold(tx, { accountId: account, appointmentId: late.id, version: 1, now: after }))).toBe('expired');
    // A BOOK message sent before the hold ended still confirms while the slot is free.
    const lateOk = await worker((tx) => confirmHold(tx, { accountId: account, code: late.hold_code as string, contactId: contacts[7],
      messageAt: late.hold_expires_at as Date, whatsappConfigId: null, now: new Date(Date.now() + 31 * 60_000) }));
    expect(lateOk.status).toBe('confirmed');
    // ...but not when someone else took the slot after expiry; nor after the hold ended.
    const third = (await hold(at('2026-12-05T09:30:00Z'))).appointment;
    await worker((tx) => expireHold(tx, { accountId: account, appointmentId: third.id, version: 1, now: after }));
    await staffBook({ serviceId: ids.single, staffId: ids.s2, startAt: at('2026-12-05T09:30:00Z'), contactId: contacts[8] });
    await expect(worker((tx) => confirmHold(tx, { accountId: account, code: third.hold_code as string, contactId: contacts[9],
      messageAt: third.hold_expires_at as Date, whatsappConfigId: null }))).rejects.toMatchObject({ code: 'slot_unavailable' });
    await expect(worker((tx) => confirmHold(tx, { accountId: account, code: third.hold_code as string, contactId: contacts[9],
      messageAt: new Date((third.hold_expires_at as Date).getTime() + 1000), whatsappConfigId: null }))).rejects.toMatchObject({ code: 'hold_expired' });
    await expect(worker((tx) => confirmHold(tx, { accountId: account, code: 'ZZZZZZ', contactId: contacts[9], messageAt: new Date(),
      whatsappConfigId: null }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('caps active holds per page and replays a public request id', async () => {
    const requestId = randomUUID();
    const hold = (startAt: Date, id = randomUUID()) => worker((tx) => bookAppointment(tx, {
      accountId: account, source: 'public', serviceId: ids.single, locationId: ids.location, startAt,
      bookingPageId: ids.page, sourceRef: sourceRefs.public(ids.page, id) }));
    // The confirm test above left one hold expired; settings allow three active holds per page.
    const a = await hold(at('2026-12-06T05:30:00Z'), requestId);
    expect((await hold(at('2026-12-06T05:30:00Z'), requestId))).toMatchObject({ replayed: true, appointment: { id: a.appointment.id } });
    await hold(at('2026-12-06T06:30:00Z'));
    await hold(at('2026-12-06T07:30:00Z'));
    await expect(hold(at('2026-12-06T08:30:00Z'))).rejects.toMatchObject({ code: 'too_many' });
    // A public hold may never name a contact.
    await expect(worker((tx) => bookAppointment(tx, { accountId: account, source: 'public', serviceId: ids.single, locationId: ids.location,
      startAt: at('2026-12-06T09:30:00Z'), bookingPageId: ids.page, sourceRef: 'public:x', contactId: contacts[1] }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('applies the Monday rule to the Kolkata local date, for staff too, and stores local_date', async () => {
    // Tuesday 04:00 IST is Monday 22:30 UTC: refused.
    await expect(staffBook({ serviceId: ids.monday, startAt: at('2026-12-07T22:30:00Z'), contactId: contacts[10] }))
      .rejects.toMatchObject({ code: 'day_not_allowed' });
    // Monday 00:30 IST is Sunday 19:00 UTC: accepted, local_date is the Monday.
    const { appointment } = await staffBook({ serviceId: ids.monday, startAt: at('2026-12-06T19:00:00Z'), contactId: contacts[10] });
    expect(appointment.local_date).toBe('2026-12-07');
    const slots = await withTenant(asViewer, (tx) => listSlots(tx, account, { serviceId: ids.monday, locationId: ids.location, fromDay: '2026-12-06', days: 3 }));
    expect(new Set(slots.slots.map((s) => s.localDate))).toEqual(new Set(['2026-12-07']));
    expect(slots.slots.some((s) => s.startAt === '2026-12-06T19:00:00.000Z')).toBe(false); // now busy
  });

  it('a flow source_ref replay returns the same appointment', async () => {
    const ref = sourceRefs.flow(randomUUID(), 'book_1', 4);
    const book = () => worker((tx) => bookAppointment(tx, { accountId: account, source: 'flow', serviceId: ids.single,
      locationId: ids.location, startAt: at('2026-12-09T05:30:00Z'), contactId: contacts[11], sourceRef: ref }));
    const first = await book();
    const again = await book();
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, appointment: { id: first.appointment.id } });
  });

  it('records outcomes only after the start, with follow-up tasks; viewers cannot book', async () => {
    // Insert a past confirmed appointment directly (bookings refuse past times).
    const id = randomUUID();
    await db.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,
      confirmed_at,service_name) VALUES($1,$2,$3,$4,$5,$6,now()-interval '2 hours',now()-interval '90 minutes','Asia/Kolkata','confirmed','staff',now(),'Consult')`,
    [id, account, contacts[12], ids.single, ids.s1, ids.location]);
    await withTenant(asAgent, (tx) => markOutcome(tx, { accountId: account, appointmentId: id, outcome: 'no_show', expectedVersion: 1, actorUserId: agent }));
    const task = (await db.query('SELECT kind, assigned_to, contact_id FROM tasks WHERE appointment_id=$1', [id])).rows;
    expect(task).toEqual([{ kind: 'next_step', assigned_to: agent, contact_id: contacts[12] }]);
    const { appointment: future } = await staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-10T05:30:00Z'), contactId: contacts[13] });
    await expect(withTenant(asAgent, (tx) => markOutcome(tx, { accountId: account, appointmentId: future.id, outcome: 'completed', expectedVersion: 1 })))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(staffBook({ serviceId: ids.single, staffId: ids.s1, startAt: at('2026-12-10T08:30:00Z'), contactId: contacts[14] }, asViewer)).rejects.toBeTruthy();
    expect(await activeAt(ids.single, at('2026-12-10T08:30:00Z'))).toBe(0);
  });
});
