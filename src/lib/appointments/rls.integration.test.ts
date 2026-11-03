import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { bookAppointment, cancelAppointment, getAppointment } from './booking';
import {
  createBookingPage, createLocation, createService, createStaff, deleteBookingPage, saveSettings, setOfferings, updateService,
} from './config';
import { getAppointmentDetail, resolveMessage } from './listing';
import { createTask } from './tasks';

// Tenancy and role boundaries of the Phase 7 domain functions on PostgreSQL
// (the schema-level grants are covered by migration.integration.test.ts).
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
const contactA = randomUUID(), contactB = randomUUID();
let db: pg.Client;
const fails = (work: Promise<unknown>) => work.then(() => false, () => true);
let serviceId = '', locationId = '', staffId = '', appointmentId = '';

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointments tenancy and roles on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Appt RLS', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'RLS A',$2),($3,'RLS B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550301'),($4,$5,$6,'B','14155550302')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    await withTenant(asAdmin, async (tx) => {
      await saveSettings(tx, accountA, ownerA, { min_notice_minutes: 0 });
      locationId = (await createLocation(tx, accountA, ownerA, { name: 'Clinic', timezone: 'Asia/Kolkata' })).id;
      serviceId = (await createService(tx, accountA, ownerA, { name: 'Consult', mode: 'offline', duration_minutes: 30 })).id;
      staffId = (await createStaff(tx, accountA, ownerA, { display_name: 'Dr A', user_id: agentA })).id;
      await setOfferings(tx, accountA, ownerA, { service_id: serviceId, location_id: locationId, pooled: false, staff_ids: [staffId] });
      await tx.$executeRaw`INSERT INTO appointment_hours(staff_id,location_id,hours) VALUES(${staffId}::uuid,${locationId}::uuid,
        ${JSON.stringify({ tue: [{ start: '09:00', end: '17:00' }] })}::jsonb)`;
    });
    appointmentId = (await withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: accountA, source: 'staff', serviceId, locationId,
      startAt: new Date('2026-12-08T04:30:00Z'), contactId: contactA, actorUserId: agentA }))).appointment.id;
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('another workspace cannot see, change or reference account A rows', async () => {
    expect(await withTenant(asB, (tx) => getAppointment(tx, accountA, appointmentId))).toBeNull();
    expect(await withTenant(asB, (tx) => getAppointment(tx, accountB, appointmentId))).toBeNull();
    await expect(withTenant(asB, (tx) => getAppointmentDetail(tx, accountB, appointmentId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(withTenant(asB, (tx) => cancelAppointment(tx, { accountId: accountB, appointmentId, reason: 'staff', expectedVersion: 1, actor: 'staff' })))
      .rejects.toMatchObject({ code: 'not_found' });
    // Book in B against A's service: unknown there.
    await expect(withTenant(asB, (tx) => bookAppointment(tx, { accountId: accountB, source: 'staff', serviceId, locationId,
      startAt: new Date('2026-12-08T05:30:00Z'), contactId: contactB }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(withTenant(asB, (tx) => setOfferings(tx, accountB, ownerB, { service_id: serviceId, location_id: locationId, pooled: true })))
      .rejects.toMatchObject({ code: 'not_found' });
    // Claiming another tenant's id in the function arguments does not bypass RLS.
    await expect(withTenant(asB, (tx) => updateService(tx, accountA, ownerB, serviceId, { capacity: 2 }))).rejects.toMatchObject({ code: 'not_found' });
    // A's contact cannot be used from B, and B's contact cannot be attached in A.
    await expect(withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: accountA, source: 'staff', serviceId, locationId,
      startAt: new Date('2026-12-08T06:30:00Z'), contactId: contactB }))).rejects.toBeTruthy();
    expect(Number((await db.query('SELECT count(*) FROM appointments WHERE account_id=$1', [accountB])).rows[0].count)).toBe(0);
  });

  it('agents book but cannot configure; viewers can only read', async () => {
    expect(await fails(withTenant(asAgent, (tx) => createService(tx, accountA, agentA, { name: 'Rogue', mode: 'offline', duration_minutes: 30 })))).toBe(true);
    expect(await fails(withTenant(asAgent, (tx) => saveSettings(tx, accountA, agentA, { hold_minutes: 30 })))).toBe(true);
    expect(await fails(withTenant(asAgent, (tx) => createBookingPage(tx, accountA, agentA, { slug: `rogue-${accountA.slice(0, 6)}`, title: 'R', service_ids: [serviceId] })))).toBe(true);
    expect(await fails(withTenant(asViewer, (tx) => bookAppointment(tx, { accountId: accountA, source: 'staff', serviceId, locationId,
      startAt: new Date('2026-12-08T07:30:00Z'), contactId: contactA })))).toBe(true);
    expect(await fails(withTenant(asViewer, (tx) => createTask(tx, accountA, viewerA, { title: 'Call back' })))).toBe(true);
    expect(await withTenant(asViewer, (tx) => getAppointmentDetail(tx, accountA, appointmentId))).toMatchObject({ appointment: { id: appointmentId } });
    const task = await withTenant(asAgent, (tx) => createTask(tx, accountA, agentA, { title: 'Call back', appointment_id: appointmentId }));
    expect(task.contact_id).toBe(contactA);
  });

  it('the app role cannot rewrite history, protected appointment columns or jobs', async () => {
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_events SET detail='x' WHERE appointment_id=${appointmentId}::uuid`))).toBe(true);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointments SET contact_id=NULL WHERE id=${appointmentId}::uuid`))).toBe(true);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointments SET manage_token_hash=NULL WHERE id=${appointmentId}::uuid`))).toBe(true);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE jobs SET status='done' WHERE tenant_id=${accountA}::uuid`))).toBe(true);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM jobs WHERE tenant_id=${accountA}::uuid`))).toBe(true);
  });

  it('only admins resolve message outcomes, never across tenants', async () => {
    const [msg] = await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO appointment_messages(appointment_id,version,kind,status,reason) VALUES(${appointmentId}::uuid,1,'confirmation','outcome_unknown','uncertain')
      RETURNING id`, getWorkerPrisma());
    await expect(withTenant(asAgent, (tx) => resolveMessage(tx, accountA, agentA, msg.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(withTenant(asB, (tx) => resolveMessage(tx, accountB, ownerB, msg.id))).rejects.toMatchObject({ code: 'not_found' });
    expect(await withTenant(asAdmin, (tx) => resolveMessage(tx, accountA, ownerA, msg.id))).toMatchObject({ resolved_by: ownerA });
    await expect(withTenant(asAdmin, (tx) => resolveMessage(tx, accountA, ownerA, msg.id))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('deleting a booking page keeps its appointments (page reference cleared), and slugs are global', async () => {
    const slug = `page-${accountA.slice(0, 8)}`;
    const page = await withTenant(asAdmin, (tx) => createBookingPage(tx, accountA, ownerA, { slug, title: 'Book', service_ids: [serviceId] }));
    await expect(withTenant(asB, (tx) => createBookingPage(tx, accountB, ownerB, { slug, title: 'Copy', service_ids: [] })))
      .rejects.toMatchObject({ code: 'invalid' });
    const hold = await withTenant({ accountId: accountA, role: 'owner' }, (tx) => bookAppointment(tx, { accountId: accountA, source: 'public',
      serviceId, locationId, startAt: new Date('2026-12-08T08:30:00Z'), bookingPageId: page.id, sourceRef: `public:${page.id}:${randomUUID()}` }),
    getWorkerPrisma());
    await withTenant(asAdmin, (tx) => deleteBookingPage(tx, accountA, ownerA, page.id));
    expect((await db.query('SELECT booking_page_id, status FROM appointments WHERE id=$1', [hold.appointment.id])).rows[0])
      .toEqual({ booking_page_id: null, status: 'held' });
    const audit = (await db.query(`SELECT action FROM audit_logs WHERE account_id=$1 AND action LIKE 'appointments.%' ORDER BY created_at`, [accountA])).rows
      .map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['appointments.service.created', 'appointments.offerings.updated',
      'appointments.booking_page.created', 'appointments.booking_page.deleted', 'appointments.message.resolved']));
  });
});
