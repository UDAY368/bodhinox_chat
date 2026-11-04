import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Phase 11: a WhatsApp contact linked to an Instagram identity may have a more
// recently active Instagram conversation. The appointment event fan-out still
// hands its automations the WhatsApp conversation, because they send over
// WhatsApp; the Instagram thread would only be refused (other_channel).
const automations = vi.hoisted(() => ({ run: vi.fn(async () => true) }));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: automations.run }));

import { encrypt } from '@/lib/whatsapp/encryption';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { bookAppointment } from './booking';
import { setHours, setOfferings } from './config';
import { handleAppointmentEventJob } from './events';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'http://localhost:3000';

const account = randomUUID();
const owner = randomUUID();
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const ids = { location: randomUUID(), service: randomUUID(), s1: randomUUID(), number: randomUUID(), contact: randomUUID() };
let db: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment event fan-out channel on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Channel test','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Event channel',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.number, account, owner, `pn-${account}`]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Linked customer','+14156660001')",
      [ids.contact, account, owner]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days) VALUES(0,365)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.service}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name) VALUES(${ids.s1}::uuid,'Dr One')`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      await setHours(tx, account, owner, { location_id: ids.location, staff_id: ids.s1, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.service, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
    });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=$1', [account]);
      await db.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('hands automations the WhatsApp conversation even when the linked Instagram thread is more recent', async () => {
    const wa = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id,updated_at)
      VALUES($1,$2,$3,$4,now() - interval '1 day') RETURNING id`, [account, owner, ids.contact, ids.number])).rows[0].id as string;
    const igAccount = (await db.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,ARRAY['instagram_business_basic','instagram_business_manage_messages'],$4) RETURNING id`,
      [account, `9${Date.now()}${Math.floor(Math.random() * 1e6)}`, encrypt('test-only-ig-token'), owner])).rows[0].id as string;
    // The customer's latest activity is an Instagram DM on the linked identity.
    const ig = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id,updated_at)
      VALUES($1,$2,$3,'instagram',$4,now()) RETURNING id`, [account, owner, ids.contact, igAccount])).rows[0].id as string;

    const { appointment } = await withTenant(asAdmin, (tx) => bookAppointment(tx, { accountId: account, source: 'staff',
      serviceId: ids.service, locationId: ids.location, staffId: ids.s1, contactId: ids.contact,
      startAt: new Date('2026-12-14T05:30:00Z'), actorUserId: owner }));
    await handleAppointmentEventJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmed' });

    expect(automations.run).toHaveBeenCalledTimes(1);
    const context = (automations.run.mock.calls[0] as unknown as [{ context: { conversation_id?: string } }])[0].context;
    expect(context.conversation_id).toBe(wa);
    expect(context.conversation_id).not.toBe(ig);
  });
});
