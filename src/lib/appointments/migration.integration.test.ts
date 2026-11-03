import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { deriveManageToken, manageTokenHash } from './tokens';

// Schema-level guarantees of the Phase 7 migrations (T1). Booking behaviour
// and the full RLS matrix live in booking/rls integration tests (T2).
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
const ids = {
  location: randomUUID(), service: randomUUID(), staff: randomUUID(), contact: randomUUID(), appointment: randomUUID(),
  locationB: randomUUID(), page: randomUUID(),
};
const slug = `appt-${randomUUID().slice(0, 8)}`;
let owner: pg.Client;

const fails = (work: Promise<unknown>) => work.then(() => false, () => true);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointments migrations on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Appt test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Appt A',$2),($3,'Appt B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Appt contact','14155550199')", [ids.contact, accountA, ownerA]);
    await owner.query("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'Clinic B','UTC')", [ids.locationB, accountB]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets admins configure, refuses agents, and blocks cross-tenant references', async () => {
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,allowed_weekdays)
        VALUES(${ids.service}::uuid,'Consult','offline',30,'{1}')`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.staff}::uuid,'Dr A',${agentA}::uuid)`;
      await tx.$executeRaw`INSERT INTO appointment_offerings(service_id,staff_id,location_id) VALUES(${ids.service}::uuid,${ids.staff}::uuid,${ids.location}::uuid)`;
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${slug},'Book')`;
    });
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO appointment_locations(name,timezone) VALUES('Rogue','UTC')`))).toBe(true);
    // Another tenant's location cannot be referenced (composite FK).
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO appointment_offerings(service_id,location_id)
      VALUES(${ids.service}::uuid,${ids.locationB}::uuid)`))).toBe(true);
    // Pooled duplicates collide (NULLS NOT DISTINCT).
    await withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO appointment_offerings(service_id,location_id) VALUES(${ids.service}::uuid,${ids.location}::uuid)`);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`INSERT INTO appointment_offerings(service_id,location_id)
      VALUES(${ids.service}::uuid,${ids.location}::uuid)`))).toBe(true);
    // Payment-gated services are refused until payments land; Monday arrays are bounded.
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_services SET payment_required=true WHERE id=${ids.service}::uuid`))).toBe(true);
    expect(await fails(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_services SET allowed_weekdays='{0}' WHERE id=${ids.service}::uuid`))).toBe(true);
    expect(await withTenant(asB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM appointment_services`)).toEqual([]);
  });

  it('computes local_date in the appointment zone, and agents book but cannot rewrite protected columns', async () => {
    const token = deriveManageToken(ids.appointment, 1);
    // Monday 00:30 IST = Sunday 19:00 UTC.
    await withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO appointments(id,contact_id,service_id,staff_id,location_id,start_at,end_at,
        timezone,status,source,confirmed_at,service_name,manage_token_hash)
      VALUES(${ids.appointment}::uuid,${ids.contact}::uuid,${ids.service}::uuid,${ids.staff}::uuid,${ids.location}::uuid,
        '2026-11-08T19:00:00Z','2026-11-08T19:30:00Z','Asia/Kolkata','confirmed','staff',now(),'Consult',${manageTokenHash(token)})`);
    const [row] = await withTenant(asAgent, (tx) => tx.$queryRaw<{ local_date: string }[]>`
      SELECT local_date::text AS local_date FROM appointments WHERE id=${ids.appointment}::uuid`);
    expect(row.local_date).toBe('2026-11-09');
    await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE appointments SET status='cancelled', version=version+1 WHERE id=${ids.appointment}::uuid`);
    for (const column of ['contact_id', 'manage_token_hash', 'token_epoch', 'source_ref', 'account_id']) {
      const value = column === 'token_epoch' ? '2' : column === 'manage_token_hash' ? `'${'0'.repeat(64)}'` : 'NULL';
      expect(await fails(withTenant(asAgent, (tx) => tx.$executeRawUnsafe(`UPDATE appointments SET ${column}=${value} WHERE id='${ids.appointment}'`))), column).toBe(true);
    }
    // A viewer's update matches no row under RLS.
    expect(await withTenant(asViewer, (tx) => tx.$executeRaw`UPDATE appointments SET status='confirmed' WHERE id=${ids.appointment}::uuid`)).toBe(0);
    await withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor) VALUES(${ids.appointment}::uuid,1,'confirmed','staff')`);
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE appointment_events SET kind='expired'`))).toBe(true);
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`DELETE FROM appointment_events`))).toBe(true);
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE jobs SET status='done'`))).toBe(true);
    // Message outcomes are worker-written; only admins resolve them.
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO appointment_messages(appointment_id,version,kind,status)
      VALUES(${ids.appointment}::uuid,1,'confirmation','sent')`))).toBe(true);
    await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO appointment_messages(appointment_id,version,kind,status,reason)
      VALUES(${ids.appointment}::uuid,1,'confirmation','outcome_unknown','uncertain')`, getWorkerPrisma());
    expect(await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE appointment_messages SET resolved_at=now()`)).toBe(0);
    expect(await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_messages SET resolved_at=now(), resolved_by=${ownerA}::uuid`)).toBe(1);
  });

  it('public definers return only (account_id, id), for active pages and known token hashes', async () => {
    const page = await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM resolve_booking_page(${slug})`, getWorkerPrisma());
    expect(page).toEqual([{ account_id: accountA, page_id: ids.page }]);
    const token = deriveManageToken(ids.appointment, 1);
    const appt = await withTenant({ accountId: accountB, role: 'owner' }, (tx) => tx.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM resolve_appointment_token(${manageTokenHash(token)})`, getWorkerPrisma());
    expect(appt).toEqual([{ account_id: accountA, appointment_id: ids.appointment }]);
    expect(await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM resolve_appointment_token(${'f'.repeat(64)})`, getWorkerPrisma())).toEqual([]);
    await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE booking_pages SET active=false WHERE id=${ids.page}::uuid`);
    expect(await withTenant({ accountId: accountA, role: 'owner' }, (tx) => tx.$queryRaw<unknown[]>`SELECT * FROM resolve_booking_page(${slug})`, getWorkerPrisma())).toEqual([]);
    // The app role cannot call them.
    expect(await fails(withTenant(asAdmin, (tx) => tx.$queryRaw`SELECT * FROM resolve_booking_page(${slug})`))).toBe(true);
  });

  it('keeps every earlier value in the redefined CHECK lists', async () => {
    const defs = (await owner.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1)`,
      [['notifications_type_check', 'notification_preferences_event_check', 'notification_email_queue_event_check', 'flow_nodes_node_type_check']])).rows as { conname: string; def: string }[];
    const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(Object.keys(byName).sort()).toEqual(['flow_nodes_node_type_check', 'notification_email_queue_event_check', 'notification_preferences_event_check', 'notifications_type_check']);
    for (const v of ['conversation_assigned', 'whatsapp_number_health', 'payment_received', 'assigned_message', 'mention', 'sla_breach',
      'campaign_finished', 'template_rejected', 'billing', 'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled'])
      expect(byName.notifications_type_check, v).toContain(`'${v}'`);
    for (const name of ['notification_preferences_event_check', 'notification_email_queue_event_check'])
      for (const v of ['assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality', 'appointment_booked'])
        expect(byName[name], `${name} ${v}`).toContain(`'${v}'`);
    for (const v of ['start', 'send_buttons', 'send_list', 'send_message', 'send_media', 'collect_input', 'condition', 'set_tag', 'handoff',
      'http_fetch', 'end', 'set_attribute', 'ask_media', 'ask_location', 'ask_address', 'send_template', 'api_request', 'connect_flow',
      'assign_agent', 'send_form', 'send_product', 'send_product_list', 'send_catalog', 'payment_link', 'ai_reply', 'conversion_event', 'book_appointment'])
      expect(byName.flow_nodes_node_type_check, v).toContain(`'${v}'`);
    const plans = (await owner.query(`SELECT id, features->'appointments' AS f, limits ? 'appointment_staff' AS l FROM plans WHERE id IN ('free','basic','pro','enterprise')`)).rows;
    for (const plan of plans) expect(plan, plan.id).toMatchObject({ f: true, l: true });
  });
});
