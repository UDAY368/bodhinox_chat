import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Migration 20261207070000: appointment prices stored with the browser's Intl decimal places are
// rescaled to ISO 4217 minor units. Everything runs in one transaction that is rolled back, so the
// migration's table-wide UPDATEs never touch other tests' rows.
config({ path: '.env.test', quiet: true });
const ownerUrl = process.env.TEST_DATABASE_URL;
const sql = readFileSync('prisma/migrations/20261207070000_appointment_price_iso_decimals/migration.sql', 'utf8')
  .replace(/^SET LOCAL lock_timeout.*$/m, '');

let db: pg.Client;

describe.skipIf(!ownerUrl)('appointment prices to ISO minor units (migration)', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
  });
  afterAll(async () => { await db?.end(); });

  it('rescales the 17 affected currencies, keeps payment-linked snapshots and every other currency', async () => {
    const account = randomUUID(), user = randomUUID(), location = randomUUID(), staff = randomUUID(), contact = randomUUID();
    const svc = { pkr: randomUUID(), iqd: randomUUID(), inr: randomUUID(), jpy: randomUUID(), free: randomUUID() };
    const appt = { none: randomUUID(), paid: randomUUID(), inr: randomUUID() };
    await db.query('BEGIN');
    try {
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Price test','test-only-hash')", [user, `${user}@example.invalid`]);
      await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Price test',$2)", [account, user]);
      await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Price contact','14155550123')", [contact, account, user]);
      await db.query("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'Clinic','UTC')", [location, account]);
      await db.query("INSERT INTO appointment_staff(id,account_id,display_name) VALUES($1,$2,'One')", [staff, account]);
      await db.query(`INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes,price_minor,currency) VALUES
        ($1,$6,'PKR','offline',30,1500,'PKR'),($2,$6,'IQD','offline',30,25000,'IQD'),($3,$6,'INR','offline',30,49950,'INR'),
        ($4,$6,'JPY','offline',30,3000,'JPY'),($5,$6,'Free','offline',30,NULL,NULL)`,
      [svc.pkr, svc.iqd, svc.inr, svc.jpy, svc.free, account]);
      const at = (h: number) => new Date(Date.UTC(2030, 0, 7, h));
      const insertAppt = (id: string, service: string, hour: number, price: number, currency: string, payment: string) => db.query(
        `INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,
          confirmed_at,service_name,price_minor,currency,payment_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'UTC','confirmed','staff',now(),'Consult',$9,$10,$11)`,
        [id, account, contact, service, staff, location, at(hour), at(hour + 1), price, currency, payment]);
      await insertAppt(appt.none, svc.pkr, 9, 1500, 'PKR', 'none');
      await insertAppt(appt.paid, svc.pkr, 11, 1500, 'PKR', 'paid');
      await insertAppt(appt.inr, svc.inr, 13, 49950, 'INR', 'none');

      await db.query(sql);

      const services = Object.fromEntries((await db.query<{ name: string; price: string | null }>(
        'SELECT name, price_minor::text AS price FROM appointment_services WHERE account_id=$1', [account])).rows.map((r) => [r.name, r.price]));
      expect(services).toEqual({ PKR: '150000', IQD: '25000000', INR: '49950', JPY: '3000', Free: null });
      const appts = Object.fromEntries((await db.query<{ id: string; price: string }>(
        'SELECT id::text, price_minor::text AS price FROM appointments WHERE account_id=$1', [account])).rows.map((r) => [r.id, r.price]));
      expect(appts).toEqual({ [appt.none]: '150000', [appt.paid]: '1500', [appt.inr]: '49950' });
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
