import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hash, argon2id } from 'argon2';
import { config } from 'dotenv';
import pg from 'pg';
import { FIXTURES_FILE, type Fixtures, type Role, type SeededUser } from './fixtures';
import { deriveManageToken, manageTokenHash } from '../src/lib/appointments/tokens';
import { deriveStorefrontToken, storefrontTokenHash } from '../src/lib/commerce/storefront-token';

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
  let commerce!: Fixtures['commerce'];
  let integrations!: Fixtures['integrations'];
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
    commerce = await seedCommerce(db, accountA, users.owner.id, contact.id, runId);
    integrations = await seedIntegrations(db, accountA, contact.id, runId, appointments);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }

  const data: Fixtures = { runId, accountA, accountB, users, outsider, contact, appointments, commerce, integrations };
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

/** Financial year April-March, e.g. 2026-27 (the receipt numbering of lib/commerce/documents). */
function financialYear(date: Date): string {
  const start = date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Phase 8 seed (owner connection). Amounts are minor units: 499.00 including
 * 18% tax plus 50.00 shipping (taxed the same way) = 549.00; the inclusive tax
 * is 76.12 + 7.63 = 83.75, split CGST 41.88 / SGST 41.87 (seller and buyer in state 29).
 */
async function seedCommerce(db: pg.Client, accountId: string, ownerId: string, contactId: string, runId: string): Promise<Fixtures['commerce']> {
  const ids = { productId: randomUUID(), variantId: randomUUID(), sessionId: randomUUID(), secondSessionId: randomUUID(),
    secondContactId: randomUUID(), paidOrderId: randomUUID(), paymentId: randomUUID() };
  const sku = `E2E-${runId}`;
  const productName = `E2E Ashwagandha ${runId}`;
  await db.query(`INSERT INTO commerce_settings(account_id,currency,prices_include_tax,default_tax_rate_bps,checkout_enabled,
      legal_name,state_code,document_prefix,storefront_title) VALUES($1,'INR',true,1800,true,'E2E Ayurveda Store','29','RCPT','E2E Store')`,
    [accountId]);
  await db.query(`INSERT INTO shipping_rates(account_id,name,country,fee_minor) VALUES($1,'India','IN',5000)`, [accountId]);
  await db.query(`INSERT INTO shop_products(id,account_id,name,description,status,content_reviewed_by,content_reviewed_at)
    VALUES($1,$2,$3,'Herbal supplement, 60 tablets.','published',$4,NOW())`, [ids.productId, accountId, productName, ownerId]);
  await db.query(`INSERT INTO shop_variants(id,account_id,product_id,sku,option_values,price_minor,hsn_code)
    VALUES($1,$2,$3,$4,'{"Size":"60 tablets"}',49900,'30049011')`, [ids.variantId, accountId, ids.productId, sku]);
  await db.query('INSERT INTO inventory_levels(account_id,variant_id,on_hand,reserved) VALUES($1,$2,1,0)', [accountId, ids.variantId]);
  await db.query(`INSERT INTO inventory_movements(account_id,variant_id,kind,quantity,on_hand_after,reserved_after,reason,actor_user_id)
    VALUES($1,$2,'receipt',1,1,0,'E2E seed',$3)`, [accountId, ids.variantId, ownerId]);
  await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)",
    [ids.secondContactId, accountId, ownerId, `E2E Shopper ${runId}`, `1416${String(Date.now()).slice(-7)}`]);
  const token = deriveStorefrontToken(ids.sessionId, 1);
  const secondToken = deriveStorefrontToken(ids.secondSessionId, 1);
  await db.query(`INSERT INTO storefront_sessions(id,account_id,token_hash,contact_id,purpose,expires_at)
    VALUES($1,$2,$3,$4,'shop',NOW() + interval '24 hours'),($5,$2,$6,$7,'shop',NOW() + interval '24 hours')`,
    [ids.sessionId, accountId, storefrontTokenHash(token), contactId, ids.secondSessionId, storefrontTokenHash(secondToken), ids.secondContactId]);

  const address = { name: 'E2E Shopper', phone: '+919900000000', line1: '1 MG Road', city: 'Bengaluru', state: 'Karnataka',
    state_code: '29', postal_code: '560001', country: 'IN' };
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
      tax_inclusive,total_minor,status,priced_at,shipping_address,paid_at,amount_paid_minor,checkout_attempt)
    VALUES($1,$2,'storefront',$3,'INR',49900,0,5000,8375,true,54900,'paid',NOW() - interval '1 hour',$4,NOW() - interval '50 minutes',54900,1)`,
    [ids.paidOrderId, accountId, contactId, JSON.stringify(address)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,variant_id,sku,retailer_id,name,quantity,unit_price_minor,currency,
      tax_rate_bps,tax_minor,discount_minor,line_total_minor,hsn_code)
    VALUES($1,$2,$3,$4,$4,$5,1,49900,'INR',1800,7612,0,49900,'30049011')`, [accountId, ids.paidOrderId, ids.variantId, sku, productName]);
  await db.query(`INSERT INTO customer_payments(id,account_id,source,order_id,amount_minor,currency,status,method,offline_reference,
      recorded_by,captured_at,settlement) VALUES($1,$2,'offline',$3,54900,'INR','captured','cash','E2E-SEED',$4,NOW() - interval '50 minutes','settled')`,
    [ids.paymentId, accountId, ids.paidOrderId, ownerId]);
  await db.query(`INSERT INTO order_events(account_id,order_id,kind,from_status,to_status,actor) VALUES
    ($1,$2,'priced',NULL,'awaiting_payment','customer'),($1,$2,'payment_captured','awaiting_payment','paid','system')`,
    [accountId, ids.paidOrderId]);
  const fy = financialYear(new Date());
  const receiptNumber = `RCPT/${fy}/1`;
  await db.query('INSERT INTO commerce_document_sequences(account_id,fy,next_number) VALUES($1,$2,2)', [accountId, fy]);
  await db.query(`INSERT INTO commerce_documents(account_id,order_id,payment_id,kind,number,fy,currency,seller,buyer,address,line_items,
      subtotal_minor,discount_minor,shipping_minor,tax_minor,cgst_minor,sgst_minor,igst_minor,total_minor)
    VALUES($1,$2,$3,'receipt',$4,$5,'INR',$6,$7,$8,$9,49900,0,5000,8375,4188,4187,0,54900)`,
    [accountId, ids.paidOrderId, ids.paymentId, receiptNumber, fy,
      JSON.stringify({ legal_name: 'E2E Ayurveda Store', state_code: '29' }), JSON.stringify({ name: 'E2E Shopper' }), JSON.stringify(address),
      JSON.stringify([{ sku, name: productName, hsn_code: '30049011', quantity: 1, unit_price_minor: 49900, tax_rate_bps: 1800,
        tax_minor: 7612, line_total_minor: 49900 }])]);
  return { productId: ids.productId, productName, variantId: ids.variantId, sku, token, secondToken, paidOrderId: ids.paidOrderId, receiptNumber };
}

/**
 * Phase 9 seed (owner connection). No Zoom or Shiprocket configuration and no
 * connection rows: an online service with a supplied meeting link and a
 * confirmed appointment that uses it (a Tuesday, away from the Monday booking
 * spec, with its own practitioner), and a second paid order that no other spec
 * dispatches.
 */
async function seedIntegrations(db: pg.Client, accountId: string, contactId: string, runId: string,
  appointments: Fixtures['appointments']): Promise<Fixtures['integrations']> {
  const ids = { serviceId: randomUUID(), staffId: randomUUID(), appointmentId: randomUUID(), orderId: randomUUID() };
  const meetingUrl = `https://meet.example.invalid/e2e-${runId}`;
  await db.query(`INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes,capacity,meeting_url)
    VALUES($1,$2,'E2E Video consultation','online',30,1,$3)`, [ids.serviceId, accountId, meetingUrl]);
  await db.query("INSERT INTO appointment_staff(id,account_id,display_name) VALUES($1,$2,'Dr Online E2E')", [ids.staffId, accountId]);
  const tuesday = new Date(Date.parse(`${appointments.appointmentDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await db.query(`INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,
      source,confirmed_at,service_name,meeting_url)
    VALUES($1,$2,$3,$4,$5,$6,($7 || ' 11:00')::timestamp AT TIME ZONE $8,($7 || ' 11:30')::timestamp AT TIME ZONE $8,$8,'confirmed',
      'staff',NOW(),'E2E Video consultation',$9)`,
    [ids.appointmentId, accountId, contactId, ids.serviceId, ids.staffId, appointments.locationId, tuesday, appointments.timezone, meetingUrl]);
  const address = { name: 'E2E Shopper', phone: '+919900000002', line1: '3 MG Road', city: 'Bengaluru', state: 'Karnataka',
    state_code: '29', postal_code: '560001', country: 'IN' };
  await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,discount_minor,shipping_minor,tax_minor,
      tax_inclusive,total_minor,status,priced_at,shipping_address,paid_at,amount_paid_minor,checkout_attempt)
    VALUES($1,$2,'storefront',$3,'INR',49900,0,5000,8375,true,54900,'paid',NOW() - interval '1 hour',$4,NOW() - interval '50 minutes',54900,1)`,
    [ids.orderId, accountId, contactId, JSON.stringify(address)]);
  await db.query(`INSERT INTO order_items(account_id,order_id,sku,retailer_id,name,quantity,unit_price_minor,currency,
      tax_rate_bps,tax_minor,discount_minor,line_total_minor,hsn_code)
    VALUES($1,$2,$3,$3,'E2E shipping check',1,49900,'INR',1800,7612,0,49900,'30049011')`, [accountId, ids.orderId, `E2E-SHIP-${runId}`]);
  return { onlineAppointmentId: ids.appointmentId, meetingUrl, unshippedOrderId: ids.orderId };
}
