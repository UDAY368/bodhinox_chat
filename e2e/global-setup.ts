import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, argon2id } from 'argon2';
import { config } from 'dotenv';
import pg from 'pg';
import { FIXTURES_FILE, type Fixtures, type Role, type SeededUser } from './fixtures';
import { deriveManageToken, manageTokenHash } from '../src/lib/appointments/tokens';

/** Owner connection to the isolated test database; refuses anything else. */
export async function testDatabase(): Promise<pg.Client> {
  if (process.env.DATABASE_ENV_FILE) config({ path: process.env.DATABASE_ENV_FILE, quiet: true, override: true });
  config({ path: '.env.test', quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for end-to-end tests');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS name');
  if (!/test/i.test(rows[0].name)) {
    await client.end();
    throw new Error('End-to-end tests require an isolated test database');
  }
  return client;
}

export default async function globalSetup() {
  const db = await testDatabase();
  const runId = randomBytes(4).toString('hex');
  const newUser = (label: string): SeededUser => ({
    id: randomUUID(),
    email: `e2e-${runId}-${label}@example.invalid`,
    // Meets the password policy: upper, lower, digit, symbol, length.
    password: `Aa1!${randomBytes(12).toString('base64url')}`,
  });
  const roles: Role[] = ['owner', 'admin', 'agent', 'viewer'];
  const users = Object.fromEntries(roles.map((role) => [role, newUser(role)])) as Record<Role, SeededUser>;
  const outsider = newUser('outsider');
  const accountA = randomUUID(), accountB = randomUUID();
  const contact = { id: randomUUID(), name: `E2E Consent ${runId}` };
  let appointments!: Fixtures['appointments'];
  const members: [string, SeededUser, Role][] = [
    ...roles.map((role) => [accountA, users[role], role] as [string, SeededUser, Role]),
    [accountB, outsider, 'owner'],
  ];

  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE bodhinox_auth');
    for (const [, user] of members) {
      const passwordHash = await hash(user.password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      await db.query(
        'INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,NOW())',
        [user.id, user.email, `E2E ${user.email.split('@')[0]}`, passwordHash],
      );
    }
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,$2,$3),($4,$5,$6)",
      [accountA, `E2E workspace ${runId}`, users.owner.id, accountB, `E2E other ${runId}`, outsider.id]);
    for (const [account, user, role] of members) {
      await db.query('INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,$3)', [account, user.id, role]);
      await db.query('INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,$2,$3,$4,$5)',
        [user.id, `E2E ${role}`, user.email, account, role]);
    }
    await db.query('COMMIT');
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)",
      [contact.id, accountA, users.owner.id, contact.name, `1415${String(Date.now()).slice(-7)}`]);
    // A variable-free approved template, so campaigns can be scheduled without WhatsApp.
    await db.query("INSERT INTO message_templates(account_id,user_id,name,body_text,status) VALUES($1,$2,'e2e_template','Hello from E2E','APPROVED')",
      [accountA, users.owner.id]);
    appointments = await seedAppointments(db, accountA, contact.id, runId);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }

  const data: Fixtures = { runId, accountA, accountB, users, outsider, contact, appointments };
  fs.mkdirSync(path.dirname(FIXTURES_FILE), { recursive: true });
  fs.writeFileSync(FIXTURES_FILE, JSON.stringify(data, null, 2));
}

/** The next Monday (YYYY-MM-DD) strictly after today in Asia/Kolkata, at least 2 days out. */
function nextKolkataMonday(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  let offset = (8 - base.getUTCDay()) % 7 || 7;
  if (offset < 2) offset += 7;
  return new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Phase 7 seed (owner connection, like the contact above). */
async function seedAppointments(db: pg.Client, accountId: string, contactId: string, runId: string): Promise<Fixtures['appointments']> {
  const timezone = 'Asia/Kolkata';
  const ids = { serviceId: randomUUID(), staffId: randomUUID(), locationId: randomUUID(), appointmentId: randomUUID(), pageId: randomUUID() };
  const pageSlug = `e2e-${runId}`;
  const weekday = [{ start: '09:00', end: '17:00' }];
  await db.query("INSERT INTO appointment_locations(id,account_id,name,timezone,kind) VALUES($1,$2,'E2E Clinic',$3,'physical')",
    [ids.locationId, accountId, timezone]);
  await db.query(`INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes,capacity,allowed_weekdays)
    VALUES($1,$2,'E2E Free consultation','offline',30,1,'{1}')`, [ids.serviceId, accountId]);
  await db.query("INSERT INTO appointment_staff(id,account_id,display_name) VALUES($1,$2,'Dr E2E')", [ids.staffId, accountId]);
  await db.query('INSERT INTO appointment_offerings(account_id,service_id,staff_id,location_id) VALUES($1,$2,$3,$4)',
    [accountId, ids.serviceId, ids.staffId, ids.locationId]);
  await db.query('INSERT INTO appointment_hours(account_id,staff_id,location_id,hours) VALUES($1,$2,$3,$4)',
    [accountId, ids.staffId, ids.locationId, JSON.stringify({ mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday })]);
  await db.query("INSERT INTO booking_pages(id,account_id,slug,title,location_id) VALUES($1,$2,$3,'E2E Clinic bookings',$4)",
    [ids.pageId, accountId, pageSlug, ids.locationId]);
  await db.query('INSERT INTO booking_page_services(account_id,page_id,service_id) VALUES($1,$2,$3)', [accountId, ids.pageId, ids.serviceId]);
  // 16:00 local on that Monday: leaves the morning free for the booking spec.
  const appointmentDate = nextKolkataMonday();
  const manageToken = deriveManageToken(ids.appointmentId, 1);
  await db.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,
      source,confirmed_at,service_name,manage_token_hash)
    VALUES($1,$2,$3,$4,$5,$6,($7 || ' 16:00')::timestamp AT TIME ZONE $8,($7 || ' 16:30')::timestamp AT TIME ZONE $8,$8,'confirmed',
      'staff',NOW(),'E2E Free consultation',$9)`,
    [ids.appointmentId, accountId, contactId, ids.serviceId, ids.staffId, ids.locationId, appointmentDate, timezone, manageTokenHash(manageToken)]);
  return { serviceId: ids.serviceId, staffId: ids.staffId, locationId: ids.locationId, timezone, pageSlug,
    appointmentId: ids.appointmentId, appointmentDate, manageToken };
}
