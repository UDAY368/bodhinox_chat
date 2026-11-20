import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { bookingsForAds, bookingsForBroadcast, resolveAttribution } from './attribution';
import { bookAppointment, confirmHold } from './booking';
import { setHours, setOfferings } from './config';
import { sourceRefs } from './keys';
import { confirmPaidHoldTx, handleAppointmentPaymentLinkJob } from './paid';
import { isAppointmentError } from './types';

// Batch 3 WP-C on PostgreSQL: a paid service booked from a flow is held, its
// payment link goes out on the booking's own conversation, and only settlement
// confirms it (A6); two concurrent flow bookings for the last seat leave one
// winner; a confirmed booking carries the contact's latest campaign click and
// ad referral inside their windows, never another workspace's (B11/B12).
// Razorpay is never called (the link module is a fake that stores the row).

const h = vi.hoisted(() => ({
  owner: '',
  sends: [] as { linkId: string; intentKey: string }[],
  creates: [] as { conversationId: string | null; appointmentId: string | null }[],
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
    sendPaymentLinkMessage: async (args: { linkId: string; intentKey: string }) => {
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

const account = randomUUID(), other = randomUUID();
const owner = randomUUID(), agent = randomUUID();
h.owner = owner;
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const contacts = Array.from({ length: 6 }, () => randomUUID());
const otherContact = randomUUID();
const conversations: Record<string, string> = {};
const ids = { location: randomUUID(), paid: randomUUID(), free: randomUUID(), s1: randomUUID(), number: randomUUID(), ig: randomUUID(),
  broadcastOld: randomUUID(), broadcastNew: randomUUID(), otherBroadcast: randomUUID() };
const PRICE = 70000;
const meta = { attempts: 1, maxAttempts: 5 };
let db: pg.Client;

const worker = <T>(work: (tx: TenantTransaction) => Promise<T>, accountId = account) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
const at = (iso: string) => new Date(iso);
const flowBook = (contactId: string, startAt: Date, serviceId = ids.free, conversationId: string | null = conversations[contactId]) =>
  worker((tx) => bookAppointment(tx, {
    accountId: account, source: 'flow', serviceId, locationId: ids.location, staffId: ids.s1, startAt, contactId,
    sourceRef: sourceRefs.flow(randomUUID(), 'book', 1), conversationId }));
const row = async (id: string) => (await db.query(
  `SELECT status, version, payment_status, conversation_id::text, broadcast_id::text, ad_referral_id::text, hold_expires_at
   FROM appointments WHERE id=$1`, [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flow bookings, channels and attribution on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Flow test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Flow A',$3),($2,'Flow B',$3)", [account, other, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [account, other]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($4,$2,'owner')", [account, owner, agent, other]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.number, account, owner, `pn-${account}`]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,phone)
      SELECT c, $2, $3, '+1415888' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,phone) VALUES($1,$2,$3,'+14158889999')`, [otherContact, other, owner]);
    for (const contactId of contacts) {
      const { rows } = await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id) VALUES($1,$2,$3,$4) RETURNING id::text`,
        [account, owner, contactId, ids.number]);
      conversations[contactId] = rows[0].id;
    }
    await db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc) VALUES($1,'razorpay','test','rzp_test_FLOW','enc')`, [account]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days,max_active_holds_per_page) VALUES(0,365,20)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes,price_minor,currency,payment_required)
        VALUES(${ids.paid}::uuid,'Paid consult','offline',30,${PRICE},'INR',true)`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.free}::uuid,'Free consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.s1}::uuid,'Doctor One',${agent}::uuid)`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      await setHours(tx, account, owner, { location_id: ids.location, staff_id: ids.s1, hours: allDay });
      for (const service of [ids.paid, ids.free])
        await setOfferings(tx, account, owner, { service_id: service, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
    });
    // Campaign clicks for contacts[2]: one 10 days ago (outside the window), one 2 days ago (inside).
    await db.query(`INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES
      ($1,$4,$5,'Old','book_now','sent'),($2,$4,$5,'New','book_now','sent'),($3,$6,$5,'Other','book_now','sent')`,
      [ids.broadcastOld, ids.broadcastNew, ids.otherBroadcast, account, owner, other]);
    for (const [broadcast, days] of [[ids.broadcastOld, 10], [ids.broadcastNew, 2]] as const) {
      const { rows } = await db.query(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status) VALUES($1,$2,$3,'delivered') RETURNING id`,
        [account, broadcast, contacts[2]]);
      await db.query(`INSERT INTO broadcast_clicks(account_id,broadcast_id,recipient_id,clicked_at) VALUES($1,$2,$3,now() - make_interval(days => $4::int))`,
        [account, broadcast, rows[0].id, days]);
    }
    // Another workspace's click, a minute ago, on its own contact.
    const { rows: otherRecipient } = await db.query(`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status)
      VALUES($1,$2,$3,'delivered') RETURNING id`, [other, ids.otherBroadcast, otherContact]);
    await db.query(`INSERT INTO broadcast_clicks(account_id,broadcast_id,recipient_id,clicked_at) VALUES($1,$2,$3,now() - interval '1 minute')`,
      [other, ids.otherBroadcast, otherRecipient[0].id]);
    // Ad referrals for contacts[2]: an ad 3 days ago (inside 28 days), a later boosted post (not an ad).
    await db.query(`INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,source_id,source_type,created_at) VALUES
      ($1,$2,$3,'1200000000001','ad',now() - interval '3 days'),($1,$2,$4,'99_1','post',now() - interval '1 day')`,
      [account, contacts[2], `wamid.ad.${account}`, `wamid.post.${account}`]);
  });

  beforeEach(() => {
    h.sends.length = 0;
    h.creates.length = 0;
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[account, other]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('A6: a paid flow booking is held, its link goes out on the run conversation, and only settlement confirms it', async () => {
    const { appointment } = await flowBook(contacts[0], at('2026-12-21T05:30:00Z'), ids.paid);
    expect(appointment).toMatchObject({ status: 'held', payment_status: 'pending', hold_code: null, conversation_id: conversations[contacts[0]] });
    expect(appointment.hold_expires_at!.getTime() - Date.now()).toBeGreaterThan(19 * 60_000);
    const jobs = (await db.query(`SELECT type FROM jobs WHERE tenant_id=$1 AND payload->>'appointmentId'=$2 ORDER BY type`, [account, appointment.id]))
      .rows.map((r) => r.type);
    expect(jobs).toEqual(expect.arrayContaining(['appointments.payment_link']));
    const events = (await db.query('SELECT kind, detail FROM appointment_events WHERE appointment_id=$1', [appointment.id])).rows;
    expect(events).toEqual([{ kind: 'payment_pending', detail: 'flow' }]);

    // The hold blocks the slot for anyone else.
    await expect(flowBook(contacts[1], at('2026-12-21T05:30:00Z'))).rejects.toMatchObject({ code: 'slot_unavailable' });

    expect(await handleAppointmentPaymentLinkJob(account, { appointmentId: appointment.id, version: 1 }, meta)).toEqual({ status: 'sent', reason: null });
    expect(h.creates).toEqual([expect.objectContaining({ conversationId: conversations[contacts[0]], appointmentId: appointment.id })]);
    expect(h.sends).toHaveLength(1);
    // A replayed job never sends twice.
    expect(await handleAppointmentPaymentLinkJob(account, { appointmentId: appointment.id, version: 1 }, meta)).toBeNull();
    expect(h.sends).toHaveLength(1);

    const paymentId = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,appointment_id,amount_minor,currency,status,captured_at)
      VALUES($1,$2,'razorpay',$3,$4,$5,'INR','captured',now())`, [paymentId, account, `pay_${paymentId.slice(0, 14).replace(/-/g, '')}`, appointment.id, PRICE]);
    const outcome = await worker((tx) => confirmPaidHoldTx(tx, { accountId: account, appointmentId: appointment.id, paymentId, amountMinor: PRICE, currency: 'INR' }));
    expect(outcome).toEqual({ kind: 'confirmed' });
    expect(await row(appointment.id)).toMatchObject({ status: 'confirmed', payment_status: 'paid', conversation_id: conversations[contacts[0]] });
  });

  it('A6: a wrong amount never confirms a flow hold', async () => {
    const { appointment } = await flowBook(contacts[3], at('2026-12-22T05:30:00Z'), ids.paid);
    const paymentId = randomUUID();
    await db.query(`INSERT INTO customer_payments(id,account_id,source,provider_payment_id,appointment_id,amount_minor,currency,status,captured_at)
      VALUES($1,$2,'razorpay',$3,$4,1,'INR','captured',now())`, [paymentId, account, `pay_${paymentId.slice(0, 14).replace(/-/g, '')}`, appointment.id]);
    expect(await worker((tx) => confirmPaidHoldTx(tx, { accountId: account, appointmentId: appointment.id, paymentId, amountMinor: 1, currency: 'INR' })))
      .toEqual({ kind: 'not_payable', reason: 'amount_mismatch' });
    expect(await row(appointment.id)).toMatchObject({ status: 'held', payment_status: 'pending' });
  });

  it('two concurrent flow bookings for the last seat: exactly one wins', async () => {
    const startAt = at('2026-12-23T06:00:00Z');
    for (let round = 0; round < 3; round++) {
      const slot = new Date(startAt.getTime() + round * 60 * 60_000);
      const results = await Promise.allSettled([flowBook(contacts[4], slot), flowBook(contacts[5], slot)]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(isAppointmentError(lost[0].reason) && lost[0].reason.code).toBe('slot_unavailable');
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM appointments WHERE account_id=$1 AND staff_id=$2 AND start_at=$3
        AND status IN ('confirmed','held')`, [account, ids.s1, slot]);
      expect(rows[0].n).toBe(1);
    }
  });

  it('B11/B12: a confirmed booking carries the latest in-window campaign click and ad, and a staff booking writes them as the app role', async () => {
    const attribution = await worker((tx) => resolveAttribution(tx, account, contacts[2], new Date()));
    expect(attribution).toEqual({ broadcastId: ids.broadcastNew, adReferralId: expect.any(String) });
    const { rows: ad } = await db.query(`SELECT id::text FROM ad_referrals WHERE account_id=$1 AND source_type='ad'`, [account]);
    expect(attribution.adReferralId).toBe(ad[0].id);

    const flow = await flowBook(contacts[2], at('2026-12-24T05:30:00Z'));
    expect(await row(flow.appointment.id)).toMatchObject({ status: 'confirmed', broadcast_id: ids.broadcastNew, ad_referral_id: ad[0].id,
      conversation_id: conversations[contacts[2]] });
    const staff = await withTenant(asAgent, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', serviceId: ids.free,
      locationId: ids.location, staffId: ids.s1, startAt: at('2026-12-24T07:30:00Z'), contactId: contacts[2] }));
    expect(staff.appointment).toMatchObject({ broadcast_id: ids.broadcastNew, ad_referral_id: ad[0].id });
    // A contact without clicks gets none.
    const plain = await flowBook(contacts[1], at('2026-12-24T09:30:00Z'));
    expect(await row(plain.appointment.id)).toMatchObject({ broadcast_id: null, ad_referral_id: null });
  });

  it('B12: attribution never crosses workspaces', async () => {
    // Account A's contact read under account B's tenant: nothing (RLS and the account filter).
    expect(await worker((tx) => resolveAttribution(tx, other, contacts[2], new Date()), other)).toEqual({ broadcastId: null, adReferralId: null });
    // B's click never reaches A's bookings report, and A's broadcast is invisible from B.
    expect((await worker((tx) => bookingsForBroadcast(tx, account, ids.otherBroadcast))).bookings).toBe(0);
    expect((await worker((tx) => bookingsForBroadcast(tx, other, ids.broadcastNew), other)).bookings).toBe(0);
  });

  it('B11/B12: report helpers count attributed bookings and paid revenue per currency', async () => {
    const campaign = await withTenant(asAgent, (tx) => bookingsForBroadcast(tx, account, ids.broadcastNew));
    expect(campaign.bookings).toBeGreaterThanOrEqual(2);
    expect(campaign.paidBookings).toBe(0);
    expect(campaign.revenue).toEqual([]);
    const ads = await withTenant(asAgent, (tx) => bookingsForAds(tx, account, { from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) }));
    expect(ads.byAd).toEqual([expect.objectContaining({ adId: '1200000000001', bookings: campaign.bookings })]);
  });

  it('BOOK code confirmation stores the chat it arrived in and the attribution', async () => {
    const pageId = randomUUID();
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${pageId}::uuid,${`flow-${account.slice(0, 8)}`},'Book')`;
      await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${pageId}::uuid,${ids.free}::uuid)`;
    });
    const { appointment } = await worker((tx) => bookAppointment(tx, { accountId: account, source: 'public', serviceId: ids.free,
      locationId: ids.location, staffId: ids.s1, startAt: at('2026-12-26T05:30:00Z'), bookingPageId: pageId, sourceRef: sourceRefs.public(pageId, randomUUID()) }));
    const confirmed = await worker((tx) => confirmHold(tx, { accountId: account, code: appointment.hold_code as string, contactId: contacts[2],
      messageAt: new Date(), whatsappConfigId: ids.number }));
    expect(confirmed.status).toBe('confirmed');
    expect(await row(appointment.id)).toMatchObject({ conversation_id: conversations[contacts[2]], broadcast_id: ids.broadcastNew });
  });
});
