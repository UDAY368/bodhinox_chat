import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { loadPublicPage } from '@/app/api/public/booking/_lib/views';
import { bookAppointment, cancelAppointment, confirmHold, expireHold } from './booking';
import { setHours, setOfferings } from './config';
import { sourceRefs } from './keys';
import { appointmentPaymentReference, confirmPaidHoldTx, handleAppointmentPaymentLinkJob, paidBookingReady } from './paid';
import { isAppointmentError } from './types';

// Phase 8 paid appointments (design E15) on PostgreSQL: a public hold of a
// paid service is bound by BOOK, gets one payment link, and is confirmed only
// by settlement (confirmPaidHoldTx); a late capture after the slot was taken
// is slot_lost; a double capture confirms once; flows still refuse paid
// services. Razorpay is never called: the link module is replaced by a fake
// that stores the row the way createPaymentLinkRecord does.

const h = vi.hoisted(() => ({
  owner: '',
  sends: [] as { linkId: string; intentKey: string; message: string }[],
  creates: [] as { referenceId: string; amountMinor: number; currency: string; expireBy: Date; conversationId: string | null; appointmentId: string | null }[],
}));

vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId: async () => h.owner }));
vi.mock('@/lib/payments/links', async () => {
  const { withTenant: tenant } = await import('@/lib/db/tenant');
  const { getWorkerPrisma: workerPrisma } = await import('@/lib/db/prisma');
  class PaymentLinkError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  return {
    MIN_EXPIRE_MINUTES: 16,
    PaymentLinkError,
    createPaymentLinkRecord: async (input: { accountId: string; amountMinor: number; currency: string; referenceId: string;
      expireBy: Date; contactId: string; conversationId: string | null; appointmentId: string | null; description: string }) => {
      h.creates.push(input);
      const rows = await tenant({ accountId: input.accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string; status: string; short_url: string }[]>`
        INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,description,contact_id,conversation_id,appointment_id,status,
          expires_at,short_url,provider_link_id)
        VALUES(${input.accountId}::uuid,'razorpay',${input.referenceId},${BigInt(input.amountMinor)},${input.currency},${input.description},
          ${input.contactId}::uuid,${input.conversationId}::uuid,${input.appointmentId}::uuid,'created',${input.expireBy},'https://rzp.io/i/test',
          ${`plink_${input.referenceId.slice(3, 20)}`})
        ON CONFLICT(reference_id) DO UPDATE SET reference_id=EXCLUDED.reference_id
        RETURNING id::text, status, short_url`, workerPrisma());
      return { link: rows[0], outcome: 'created' };
    },
    sendPaymentLinkMessage: async (args: { linkId: string; intentKey: string; message: string }) => {
      h.sends.push(args);
      return { whatsappMessageId: 'wamid.link', messageId: null };
    },
  };
});


const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID();
const owner = randomUUID(), agent = randomUUID();
h.owner = owner;
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const contacts = Array.from({ length: 8 }, () => randomUUID());
const ids = { location: randomUUID(), paid: randomUUID(), free: randomUUID(), s1: randomUUID(), page: randomUUID(), number: randomUUID() };
const PRICE = 50000;
const meta = { attempts: 1, maxAttempts: 5 };
let db: pg.Client;

const worker = <T>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, work, getWorkerPrisma());
const at = (iso: string) => new Date(iso);
const hold = (startAt: Date, serviceId = ids.paid) => worker((tx) => bookAppointment(tx, {
  accountId: account, source: 'public', serviceId, locationId: ids.location, staffId: ids.s1, startAt,
  bookingPageId: ids.page, sourceRef: sourceRefs.public(ids.page, randomUUID()), intake: { name: 'Meera' } }));
const book = (code: string, contactId: string, now?: Date) => worker((tx) => confirmHold(tx, {
  accountId: account, code, contactId, messageAt: new Date(), whatsappConfigId: null, now }));
const row = async (id: string) => (await db.query(
  'SELECT status, version, payment_status, contact_id, hold_expires_at, manage_token_hash FROM appointments WHERE id=$1', [id])).rows[0];
const events = async (id: string) => (await db.query(
  'SELECT kind, detail FROM appointment_events WHERE appointment_id=$1 ORDER BY created_at, kind', [id])).rows.map((r) => `${r.kind}:${r.detail ?? ''}`);
async function payment(appointmentId: string, amount = PRICE, currency = 'INR'): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,appointment_id,amount_minor,currency,status,captured_at)
    VALUES($1,$2,'razorpay',$3,$4,$5,$6,'captured',now())`, [id, account, `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`, appointmentId, amount, currency]);
  return id;
}
/** What settlePaymentTx does around the call: confirm under its transaction, then mark the payment settled. */
const settle = (appointmentId: string, paymentId: string, amountMinor = PRICE, currency = 'INR') => worker(async (tx) => {
  const outcome = await confirmPaidHoldTx(tx, { accountId: account, appointmentId, paymentId, amountMinor, currency });
  if (outcome.kind === 'confirmed') await tx.$executeRaw`UPDATE customer_payments SET settlement='settled' WHERE id=${paymentId}::uuid`;
  return outcome;
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('paid appointments on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Paid test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Paid A',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent')", [account, owner, agent]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.number, account, owner, `pn-${account}`]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, NULL, '+1415777' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    for (const contactId of contacts) await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id)
      VALUES($1,$2,$3,$4)`, [account, owner, contactId, ids.number]);
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_PAID','enc')`, [account]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days,max_active_holds_per_page) VALUES(0,365,20)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,price_minor,currency,payment_required)
        VALUES(${ids.paid}::uuid,'Ayurveda consult','offline',30,${PRICE},'INR',true)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.free}::uuid,'Free consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.s1}::uuid,'Vaidya One',${agent}::uuid)`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      await setHours(tx, account, owner, { location_id: ids.location, staff_id: ids.s1, hours: allDay });
      for (const service of [ids.paid, ids.free])
        await setOfferings(tx, account, owner, { service_id: service, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${`paid-${account.slice(0, 8)}`},'Book')`;
      await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${ids.page}::uuid,${ids.paid}::uuid),(${ids.page}::uuid,${ids.free}::uuid)`;
    });
  });

  beforeEach(() => {
    h.sends.length = 0;
    h.creates.length = 0;
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('offers a paid service publicly only while the storefront feature and Razorpay are on', async () => {
    const page = await worker((tx) => loadPublicPage(tx, account, ids.page));
    expect(page?.services.map((s) => [s.name, s.paymentRequired])).toEqual([['Ayurveda consult', true], ['Free consult', false]]);
    await db.query("DELETE FROM payment_providers WHERE account_id=$1", [account]);
    try {
      expect(await worker((tx) => paidBookingReady(tx, account))).toBe(false);
      expect((await worker((tx) => loadPublicPage(tx, account, ids.page)))?.services.map((s) => s.name)).toEqual(['Free consult']);
      await expect(hold(at('2026-12-14T05:30:00Z'))).rejects.toMatchObject({ code: 'not_yet_supported' });
    } finally {
      await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_PAID','enc')`, [account]);
    }
    expect(await worker((tx) => paidBookingReady(tx, account))).toBe(true);
  });

  it('hold -> BOOK -> one link -> verified capture -> confirmed, once', async () => {
    const { appointment } = await hold(at('2026-12-15T05:30:00Z'));
    expect(appointment).toMatchObject({ status: 'held', payment_status: 'pending' });

    const bound = await book(appointment.hold_code as string, contacts[0]);
    expect(bound.status).toBe('payment_pending');
    const after = await row(appointment.id);
    expect(after).toMatchObject({ status: 'held', version: 2, payment_status: 'pending', contact_id: contacts[0], manage_token_hash: null });
    // Extended to at least 20 minutes so the link (Razorpay minimum 15) fits.
    expect(after.hold_expires_at.getTime() - Date.now()).toBeGreaterThan(19 * 60_000);
    const jobs = (await db.query(`SELECT type, dedupe_key FROM jobs WHERE tenant_id=$1 AND payload->>'appointmentId'=$2 ORDER BY dedupe_key`,
      [account, appointment.id])).rows;
    expect(jobs).toEqual(expect.arrayContaining([
      { type: 'appointments.payment_link', dedupe_key: `appt-link:${appointment.id}:2` },
      { type: 'appointments.hold_expire', dedupe_key: `appt-hold:${appointment.id}:v2` },
    ]));
    // Nothing confirms yet: no confirmation notice, no manage link.
    expect(jobs.some((j) => j.dedupe_key.startsWith(`appt-ntf:${appointment.id}`))).toBe(false);
    // The same sender repeating BOOK is a replay; someone else's BOOK is a miss.
    expect((await book(appointment.hold_code as string, contacts[0])).status).toBe('payment_pending');
    expect((await row(appointment.id)).version).toBe(2);
    await expect(book(appointment.hold_code as string, contacts[1])).rejects.toMatchObject({ code: 'not_found' });

    // The link job creates one link for this hold version and sends it once.
    expect(await handleAppointmentPaymentLinkJob(account, { appointmentId: appointment.id, version: 2 }, meta)).toEqual({ status: 'sent', reason: null });
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({ referenceId: appointmentPaymentReference(appointment.id, 2), amountMinor: PRICE, currency: 'INR', appointmentId: appointment.id });
    expect(h.creates[0].referenceId).toMatch(/^ap_[A-Za-z0-9_-]{32}$/);
    expect(h.creates[0].expireBy.getTime()).toBeGreaterThanOrEqual(after.hold_expires_at.getTime());
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].intentKey).toBe(`appt-plink:${appointment.id}:v2`);
    const link = (await db.query('SELECT id, appointment_id, provider_key_id FROM payment_links WHERE reference_id=$1',
      [h.creates[0].referenceId])).rows[0];
    expect(link).toMatchObject({ appointment_id: appointment.id, provider_key_id: 'rzp_test_PAID' });
    expect((await db.query(`SELECT status FROM appointment_messages WHERE appointment_id=$1 AND kind='payment_link'`, [appointment.id])).rows)
      .toEqual([{ status: 'sent' }]);
    expect(await handleAppointmentPaymentLinkJob(account, { appointmentId: appointment.id, version: 2 }, meta)).toBeNull();
    expect(h.sends).toHaveLength(1);

    // A mismatched amount never confirms.
    const wrong = await payment(appointment.id, PRICE - 1);
    expect(await settle(appointment.id, wrong, PRICE - 1)).toEqual({ kind: 'not_payable', reason: 'amount_mismatch' });
    expect((await row(appointment.id)).status).toBe('held');

    // Two captures (a double payment): one confirmation, the second is a duplicate.
    const first = await payment(appointment.id);
    const second = await payment(appointment.id);
    const outcomes = await Promise.all([settle(appointment.id, first), settle(appointment.id, second)]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['confirmed', 'not_payable']);
    expect(outcomes.find((o) => o.kind === 'not_payable')).toEqual({ kind: 'not_payable', reason: 'duplicate_payment' });
    const confirmed = await row(appointment.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', version: 3, payment_status: 'paid', hold_expires_at: null });
    expect(confirmed.manage_token_hash).toMatch(/^[0-9a-f]{64}$/);
    const winner = outcomes[0].kind === 'confirmed' ? first : second;
    expect(await settle(appointment.id, winner)).toEqual({ kind: 'already_confirmed' });
    expect(await events(appointment.id)).toEqual(expect.arrayContaining(['payment_pending:whatsapp_code', 'payment_captured:online', 'confirmed:payment']));
    expect((await db.query(`SELECT count(*)::int AS n FROM appointment_events WHERE appointment_id=$1 AND kind='confirmed'`, [appointment.id])).rows[0].n).toBe(1);
    const queued = (await db.query(`SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND payload->>'appointmentId'=$2`, [account, appointment.id]))
      .rows.map((r) => r.dedupe_key);
    expect(queued).toEqual(expect.arrayContaining([`appt-ntf:${appointment.id}:v3:confirmation`, `appt-evt:${appointment.id}:v3:confirmed`]));
    expect((await db.query('SELECT name FROM contacts WHERE id=$1', [contacts[0]])).rows[0].name).toBe('Meera');
    // A link job for the old version is a no-op now.
    expect(await handleAppointmentPaymentLinkJob(account, { appointmentId: appointment.id, version: 2 }, meta)).toBeNull();
  });

  it('expiry cancels the link; a late capture confirms while the slot is free and is slot_lost once it was taken', async () => {
    const expireLater = new Date(Date.now() + 90 * 60_000);
    // Slot still free: the late capture confirms.
    const free = (await hold(at('2026-12-16T05:30:00Z'))).appointment;
    await book(free.hold_code as string, contacts[2]);
    await handleAppointmentPaymentLinkJob(account, { appointmentId: free.id, version: 2 }, meta);
    expect(await worker((tx) => expireHold(tx, { accountId: account, appointmentId: free.id, version: 2, now: expireLater }))).toBe('expired');
    const linkId = (await db.query('SELECT id FROM payment_links WHERE appointment_id=$1', [free.id])).rows[0].id;
    expect((await db.query('SELECT type FROM jobs WHERE dedupe_key=$1', [`payment-link-cancel:${linkId}`])).rows).toEqual([{ type: 'payments.cancel_link' }]);
    const late = await payment(free.id);
    expect(await settle(free.id, late)).toEqual({ kind: 'confirmed' });
    expect(await row(free.id)).toMatchObject({ status: 'confirmed', payment_status: 'paid' });
    expect(await events(free.id)).toEqual(expect.arrayContaining(['payment_captured:late']));

    // Slot taken by a staff booking after expiry: slot_lost, never confirmed.
    const lost = (await hold(at('2026-12-16T07:30:00Z'))).appointment;
    await book(lost.hold_code as string, contacts[3]);
    await worker((tx) => expireHold(tx, { accountId: account, appointmentId: lost.id, version: 2, now: expireLater }));
    await withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', serviceId: ids.free, locationId: ids.location,
      staffId: ids.s1, startAt: at('2026-12-16T07:30:00Z'), contactId: contacts[4] }));
    const pay = await payment(lost.id);
    expect(await settle(lost.id, pay)).toEqual({ kind: 'slot_lost' });
    expect(await row(lost.id)).toMatchObject({ status: 'expired', payment_status: 'pending' });
    expect(await events(lost.id)).toEqual(expect.arrayContaining(['late_payment:slot_lost']));
    // A settled payment keeps the expiry job away from a paid hold.
    const kept = (await hold(at('2026-12-16T09:30:00Z'))).appointment;
    await book(kept.hold_code as string, contacts[5]);
    const settledFirst = await payment(kept.id);
    await db.query("UPDATE customer_payments SET settlement='settled' WHERE id=$1", [settledFirst]);
    expect(await worker((tx) => expireHold(tx, { accountId: account, appointmentId: kept.id, version: 2, now: expireLater }))).toBe('skipped');
  });

  it('staff cancelling a paid hold cancels its live link; a capture that still lands is closed, never confirmed', async () => {
    const held = (await hold(at('2026-12-18T05:30:00Z'))).appointment;
    await book(held.hold_code as string, contacts[1]);
    await handleAppointmentPaymentLinkJob(account, { appointmentId: held.id, version: 2 }, meta);
    const linkId = (await db.query('SELECT id FROM payment_links WHERE appointment_id=$1', [held.id])).rows[0].id;
    const cancelled = await withTenant(asAgent, (tx) => cancelAppointment(tx, { accountId: account, appointmentId: held.id,
      reason: 'staff', expectedVersion: 2, actor: 'staff', actorUserId: agent }));
    expect(cancelled).toMatchObject({ status: 'cancelled', payment_status: 'pending' });
    expect((await db.query('SELECT type, payload FROM jobs WHERE dedupe_key=$1', [`payment-link-cancel:${linkId}`])).rows)
      .toEqual([{ type: 'payments.cancel_link', payload: { linkId } }]);
    const pay = await payment(held.id);
    expect(await settle(held.id, pay)).toEqual({ kind: 'not_payable', reason: 'closed' });
    expect(await row(held.id)).toMatchObject({ status: 'cancelled' });
  });

  it('staff may book a paid service (nothing collected online); flows still refuse it; the app role cannot claim payment', async () => {
    const staff = await withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', serviceId: ids.paid,
      locationId: ids.location, staffId: ids.s1, startAt: at('2026-12-17T05:30:00Z'), contactId: contacts[6] }));
    expect(staff.appointment).toMatchObject({ status: 'confirmed', payment_status: 'none' });
    expect(await settle(staff.appointment.id, await payment(staff.appointment.id))).toEqual({ kind: 'not_payable', reason: 'not_pending' });
    const flow = worker((tx) => bookAppointment(tx, { accountId: account, source: 'flow', serviceId: ids.paid, locationId: ids.location,
      startAt: at('2026-12-17T07:30:00Z'), contactId: contacts[7], sourceRef: `flow:${randomUUID()}:book:1` }));
    await expect(flow).rejects.toSatisfy((error: unknown) => isAppointmentError(error) && error.code === 'not_yet_supported');
    await expect(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO appointments(contact_id,service_id,location_id,start_at,end_at,timezone,
      status,source,service_name,payment_status) VALUES(${contacts[7]}::uuid,${ids.paid}::uuid,${ids.location}::uuid,now()+interval '9 days',
      now()+interval '9 days 30 minutes','Asia/Kolkata','confirmed','staff','x','paid')`)).rejects.toBeTruthy();
    // A service cannot require payment without a price (database CHECK; the app role holds UPDATE on it).
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_services SET payment_required=true WHERE id=${ids.free}::uuid`))
      .rejects.toBeTruthy();
  });
});
