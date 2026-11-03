import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@/lib/auth/csrf';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { confirmHold } from '@/lib/appointments/booking';
import { BOOKING_DURABLE_LIMITS } from '@/lib/appointments/types';
import { deriveManageToken, manageTokenHash } from '@/lib/appointments/tokens';
import { GET as GET_PAGE, POST as POST_HOLD } from './[slug]/route';
import { GET as GET_SLOTS } from './[slug]/slots/route';
import { GET as GET_MANAGE, POST as POST_MANAGE } from './manage/[token]/route';
import { GET as GET_MANAGE_SLOTS } from './manage/[token]/slots/route';

// The anonymous booking routes end to end on PostgreSQL: definer lookups,
// worker-scoped reads, a public hold confirmed by a WhatsApp code, and the
// customer's manage link. Nothing on the public side reveals customer data.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
if (authUrl) process.env.AUTH_DATABASE_URL = authUrl;
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
const ORIGIN = 'http://localhost:3000';
process.env.APP_URL = ORIGIN;

const account = randomUUID();
const owner = randomUUID();
const contact = randomUUID();
const ids = { location: randomUUID(), service: randomUUID(), other: randomUUID(), staff: randomUUID(), page: randomUUID() };
const slug = `pub-${account.slice(0, 8)}`;
const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
let db: pg.Client;
let manageToken = '';
let appointmentId = '';

function nextKolkataMonday(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  let offset = (8 - base.getUTCDay()) % 7 || 7;
  if (offset < 2) offset += 7;
  return new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}
const monday = nextKolkataMonday();

const get = (url: string) => new Request(`${ORIGIN}${url}`, { headers: { 'x-forwarded-for': ip } });
const post = (url: string, body: unknown, origin = ORIGIN) => new Request(`${ORIGIN}${url}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
});
const slugParams = { params: Promise.resolve({ slug }) };
const tokenParams = () => ({ params: Promise.resolve({ token: manageToken }) });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !authUrl)('public booking routes on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Public test','test-only-hash')", [owner, `${owner}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Acme Clinic',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Secret Customer','14155550199')", [contact, account, owner]);
    await db.query('INSERT INTO appointment_settings(account_id,min_notice_minutes,horizon_days) VALUES($1,0,365)', [account]);
    await db.query("INSERT INTO appointment_locations(id,account_id,name,address,timezone) VALUES($1,$2,'Main','MG Road','Asia/Kolkata')", [ids.location, account]);
    await db.query(`INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes,allowed_weekdays,price_minor,currency)
      VALUES($1,$2,'Free consultation','offline',30,'{1}',0,'INR'),($3,$2,'Not on page','offline',30,NULL,NULL,NULL)`, [ids.service, account, ids.other]);
    await db.query("INSERT INTO appointment_staff(id,account_id,display_name) VALUES($1,$2,'Dr Rao')", [ids.staff, account]);
    await db.query('INSERT INTO appointment_offerings(account_id,service_id,staff_id,location_id) VALUES($1,$2,$3,$4),($1,$5,$3,$4)',
      [account, ids.service, ids.staff, ids.location, ids.other]);
    await db.query('INSERT INTO appointment_hours(account_id,staff_id,location_id,hours) VALUES($1,$2,$3,$4)',
      [account, ids.staff, ids.location, JSON.stringify({ mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }] })]);
    await db.query("INSERT INTO booking_pages(id,account_id,slug,title) VALUES($1,$2,$3,'Book a visit')", [ids.page, account, slug]);
    await db.query('INSERT INTO booking_page_services(account_id,page_id,service_id) VALUES($1,$2,$3)', [account, ids.page, ids.service]);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=$1', [owner]);
      const keys = [hashToken(`${BOOKING_DURABLE_LIMITS.createPerIp.action}:${ip}`)];
      if (manageToken) keys.push(hashToken(`${BOOKING_DURABLE_LIMITS.managePerToken.action}:${manageTokenHash(manageToken)}`));
      await db.query('DELETE FROM auth_rate_limits WHERE key=ANY($1::text[])', [keys]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('lists only the page services with their place and practitioner', async () => {
    const response = await GET_PAGE(get(`/api/public/booking/${slug}`), slugParams);
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toEqual({ title: 'Book a visit', businessName: 'Acme Clinic', services: [{
      id: ids.service, name: 'Free consultation', mode: 'offline', durationMinutes: 30, priceMinor: 0, currency: 'INR', group: false,
      locations: [{ id: ids.location, name: 'Main', address: 'MG Road', timezone: 'Asia/Kolkata', kind: 'physical',
        staff: [{ id: ids.staff, displayName: 'Dr Rao' }] }],
    }] });
  });

  it('offers Monday only, in Kolkata local time, and refuses services not on the page', async () => {
    const response = await GET_SLOTS(get(`/api/public/booking/${slug}/slots?service=${ids.service}&location=${ids.location}&from=${monday}&days=2`), slugParams);
    expect(response.status).toBe(200);
    const { timezone, slots } = await response.json();
    expect(timezone).toBe('Asia/Kolkata');
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s: { localDate: string }) => s.localDate))).toEqual(new Set([monday]));
    expect(slots[0]).toEqual({ startAt: expect.any(String), endAt: expect.any(String), localDate: monday, hhmm: '09:00', remaining: 1 });
    const other = await GET_SLOTS(get(`/api/public/booking/${slug}/slots?service=${ids.other}&location=${ids.location}&days=2`), slugParams);
    expect(other.status).toBe(404);
  });

  it('holds a slot without a contact, replays by request id, and confirms by WhatsApp code', async () => {
    const startAt = new Date(`${monday}T04:30:00Z`).toISOString(); // 10:00 IST
    const requestId = randomUUID();
    const body = { serviceId: ids.service, locationId: ids.location, startAt, requestId, intake: { name: 'Walk In', city: 'Pune' } };
    expect((await POST_HOLD(post(`/api/public/booking/${slug}`, body, 'https://evil.example'), slugParams)).status).toBe(403);
    const first = await POST_HOLD(post(`/api/public/booking/${slug}`, body), slugParams);
    expect(first.status).toBe(201);
    const hold = await first.json();
    expect(hold).toMatchObject({ holdCode: expect.stringMatching(/^[A-HJ-NP-Z2-9]{6}$/), startAt, timezone: 'Asia/Kolkata', whatsappUrl: null });
    const again = await (await POST_HOLD(post(`/api/public/booking/${slug}`, body), slugParams)).json();
    expect(again.holdCode).toBe(hold.holdCode);
    const rows = (await db.query('SELECT id, status, contact_id, intake FROM appointments WHERE account_id=$1', [account])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'held', contact_id: null, intake: { name: 'Walk In', city: 'Pune' } });
    appointmentId = rows[0].id;

    // The slot is taken while held.
    const taken = await POST_HOLD(post(`/api/public/booking/${slug}`, { ...body, requestId: randomUUID() }), slugParams);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ code: 'slot_unavailable' });

    const result = await withTenant({ accountId: account, role: 'owner' }, (tx) => confirmHold(tx, {
      accountId: account, code: hold.holdCode, contactId: contact, messageAt: new Date(), whatsappConfigId: null,
    }), getWorkerPrisma());
    expect(result.status).toBe('confirmed');
    manageToken = deriveManageToken(appointmentId, 1);
  });

  it('shows the customer their booking without any customer data', async () => {
    const response = await GET_MANAGE(get(`/api/public/booking/manage/${manageToken}`), tokenParams());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/Secret Customer|14155550199|Walk In|Pune/);
    expect(JSON.parse(text)).toMatchObject({ businessName: 'Acme Clinic', status: 'confirmed', version: 2, serviceName: 'Free consultation',
      practitioner: 'Dr Rao', location: { name: 'Main', address: 'MG Road' }, online: false, timezone: 'Asia/Kolkata', priceMinor: 0,
      meetingUrl: null, canChange: true });
    const bad = await GET_MANAGE(get('/api/public/booking/manage/x'), { params: Promise.resolve({ token: 'B'.repeat(43) }) });
    expect(bad.status).toBe(404);
  });

  it('lets the customer move and then cancel the booking, with version checks', async () => {
    const slotsResponse = await GET_MANAGE_SLOTS(get(`/api/public/booking/manage/${manageToken}/slots?from=${monday}&days=1`), tokenParams());
    expect(slotsResponse.status).toBe(200);
    const { slots } = await slotsResponse.json();
    const target = slots.find((s: { hhmm: string }) => s.hhmm === '11:00');
    expect(target).toBeTruthy();
    const stale = await POST_MANAGE(post(`/api/public/booking/manage/${manageToken}`, { action: 'reschedule', startAt: target.startAt, expectedVersion: 1 }), tokenParams());
    expect(stale.status).toBe(409);
    const moved = await POST_MANAGE(post(`/api/public/booking/manage/${manageToken}`, { action: 'reschedule', startAt: target.startAt, expectedVersion: 2 }), tokenParams());
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ status: 'confirmed', version: 3, startAt: target.startAt });
    const events = (await db.query('SELECT kind, actor FROM appointment_events WHERE appointment_id=$1 ORDER BY created_at, version', [appointmentId])).rows;
    expect(events.at(-1)).toEqual({ kind: 'rescheduled', actor: 'customer' });

    const cancelled = await POST_MANAGE(post(`/api/public/booking/manage/${manageToken}`, { action: 'cancel', expectedVersion: 3 }), tokenParams());
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', canChange: false });
    expect((await db.query('SELECT cancel_reason FROM appointments WHERE id=$1', [appointmentId])).rows[0].cancel_reason).toBe('customer');
  });

  it('answers with the same 404 when the workspace loses the feature or the page is turned off', async () => {
    const before = await (await GET_PAGE(get(`/api/public/booking/${slug}`), slugParams)).status;
    expect(before).toBe(200);
    await db.query("UPDATE account_subscriptions SET plan_id='enterprise' WHERE account_id=$1", [account]);
    const plans = (await db.query("SELECT features->>'appointments' AS on FROM plans WHERE id='enterprise'")).rows[0];
    const unentitled = await GET_PAGE(get(`/api/public/booking/${slug}`), slugParams);
    if (plans?.on !== 'true') expect(unentitled.status).toBe(404);
    await db.query("UPDATE account_subscriptions SET plan_id='basic' WHERE account_id=$1", [account]);
    await db.query('UPDATE booking_pages SET active=false WHERE id=$1', [ids.page]);
    const inactive = await GET_PAGE(get(`/api/public/booking/${slug}`), slugParams);
    const unknown = await GET_PAGE(get('/api/public/booking/nope'), { params: Promise.resolve({ slug: 'no-such-page-here' }) });
    expect(inactive.status).toBe(404);
    expect(await inactive.text()).toBe(await unknown.text());
    if (plans?.on !== 'true') expect(await unentitled.text()).toBe(await GET_PAGE(get('/x'), { params: Promise.resolve({ slug: 'no-such-page-here' }) }).then((r) => r.text()));
  });
});
