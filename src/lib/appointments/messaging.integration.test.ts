import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 gate, messaging half, on PostgreSQL: a cancelled or rescheduled
// appointment never gets an obsolete reminder, refusals are recorded before
// any outbound intent, an ambiguous send is never repeated, and a BOOK code
// confirms a hold once. Meta is never called: the engine senders are fakes.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: sends.text, engineSendTemplate: sends.template }));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { bookAppointment, cancelAppointment, rescheduleAppointment, type BookInput } from './booking';
import { setHours, setOfferings } from './config';
import { handleAppointmentEventJob } from './events';
import { handleBookingCode } from './inbound';
import { handleAppointmentJob } from './job-handlers';
import { appointmentKeys, sourceRefs } from './keys';
import { handleAppointmentNoticeJob } from './notify-customer';
import { handleAppointmentReminderJob } from './reminders';

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
const owner = randomUUID(), agent = randomUUID();
const asAgent: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const asAdmin: TenantContext = { accountId: account, userId: owner, role: 'admin' };
const contacts = Array.from({ length: 8 }, () => randomUUID());
const ids = { location: randomUUID(), service: randomUUID(), s1: randomUUID(), page: randomUUID(), number: randomUUID() };
const conversations: Record<string, string> = {};
let db: pg.Client;

const worker = <T>(work: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: account, role: 'owner' }, work, getWorkerPrisma());
const staffBook = (contactId: string, startAt: Date, extra: Partial<BookInput> = {}) => withTenant(asAgent, (tx) => bookAppointment(tx, {
  accountId: account, source: 'staff', serviceId: ids.service, locationId: ids.location, staffId: ids.s1, contactId, startAt, actorUserId: agent, ...extra,
}));
const messageRow = async (id: string, version: number, kind: string) => (await db.query(
  'SELECT status, reason FROM appointment_messages WHERE account_id=$1 AND appointment_id=$2 AND version=$3 AND kind=$4',
  [account, id, version, kind])).rows[0] as { status: string; reason: string | null } | undefined;
const intent = async (key: string) => (await db.query('SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2',
  [account, `${account}:${key}`])).rows[0] as { status: string } | undefined;
const jobs = async (id: string) => (await db.query(
  "SELECT dedupe_key, status, last_error FROM jobs WHERE tenant_id=$1 AND payload->>'appointmentId'=$2 ORDER BY dedupe_key", [account, id])).rows as
  { dedupe_key: string; status: string; last_error: string | null }[];
/** A customer message in the contact's conversation opens the 24h window. */
const customerWrote = (contactId: string, minutesAgo = 5) => db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
   VALUES($1,$2,'customer','text','hi',now() - make_interval(mins => $3)) RETURNING id`, [account, conversations[contactId], minutesAgo]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment messaging on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Msg test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Messaging A',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent')", [account, owner, agent]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.number, account, owner, `pn-${account}`]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Contact ' || n, '+1415666' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    for (const contactId of contacts) {
      conversations[contactId] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id)
        VALUES($1,$2,$3,$4) RETURNING id`, [account, owner, contactId, ids.number])).rows[0].id;
    }
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days) VALUES(0,365)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.service}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.s1}::uuid,'Dr One',${agent}::uuid)`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      await setHours(tx, account, owner, { location_id: ids.location, staff_id: ids.s1, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.service, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
      await tx.$executeRaw`INSERT INTO booking_pages(id,slug,title) VALUES(${ids.page}::uuid,${`msg-${account.slice(0, 8)}`},'Book')`;
      await tx.$executeRaw`INSERT INTO booking_page_services(page_id,service_id) VALUES(${ids.page}::uuid,${ids.service}::uuid)`;
    });
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=$1', [account]);
      await db.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await db.query('DELETE FROM accounts WHERE id=$1', [account]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[owner, agent]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('a rescheduled appointment never gets its old reminder, and the event job retires the old jobs', async () => {
    const { appointment } = await staffBook(contacts[0], new Date('2026-12-07T05:30:00Z'));
    expect((await jobs(appointment.id)).map((j) => j.dedupe_key)).toEqual(expect.arrayContaining([
      appointmentKeys.reminder(appointment.id, 1, '24h'), appointmentKeys.reminder(appointment.id, 1, '2h')]));
    await withTenant(asAgent, (tx) => rescheduleAppointment(tx, { accountId: account, appointmentId: appointment.id,
      startAt: new Date('2026-12-07T07:30:00Z'), expectedVersion: 1, actor: 'staff', actorUserId: agent }));

    await handleAppointmentReminderJob(account, { appointmentId: appointment.id, version: 1, kind: '24h' });
    expect(await messageRow(appointment.id, 1, 'reminder_24h')).toEqual({ status: 'skipped', reason: 'stale_version' });
    expect(await intent(appointmentKeys.reminder(appointment.id, 1, '24h'))).toBeUndefined();
    expect(sends.template).not.toHaveBeenCalled();

    await handleAppointmentEventJob(account, { appointmentId: appointment.id, version: 2, kind: 'rescheduled' });
    const after = await jobs(appointment.id);
    for (const kind of ['24h', '2h'] as const) {
      expect(after.find((j) => j.dedupe_key === appointmentKeys.reminder(appointment.id, 1, kind)))
        .toMatchObject({ status: 'done', last_error: 'superseded' });
      expect(after.find((j) => j.dedupe_key === appointmentKeys.reminder(appointment.id, 2, kind))).toMatchObject({ status: 'pending' });
    }
    // The practitioner's linked member is told, once, with no customer content.
    const alerts = (await db.query("SELECT user_id, title, link FROM notifications WHERE account_id=$1 AND type='appointment_rescheduled'", [account])).rows;
    expect(alerts).toEqual([]); // the agent moved it themselves: never notified of their own action
    await handleAppointmentEventJob(account, { appointmentId: appointment.id, version: 2, kind: 'rescheduled' });
    expect(await intent(`${appointmentKeys.event(appointment.id, 2, 'rescheduled')}:webhook`)).toEqual({ status: 'accepted' });
  });

  it('a cancelled appointment skips its reminders; the cancelled notice goes out once inside the window', async () => {
    const { appointment } = await staffBook(contacts[1], new Date('2026-12-08T05:30:00Z'));
    await withTenant(asAgent, (tx) => cancelAppointment(tx, { accountId: account, appointmentId: appointment.id, reason: 'staff',
      expectedVersion: 1, actor: 'staff', actorUserId: agent }));
    await handleAppointmentReminderJob(account, { appointmentId: appointment.id, version: 1, kind: '2h' });
    expect(await messageRow(appointment.id, 1, 'reminder_2h')).toEqual({ status: 'skipped', reason: 'stale_version' });
    await handleAppointmentNoticeJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmation' });
    expect(await messageRow(appointment.id, 1, 'confirmation')).toEqual({ status: 'skipped', reason: 'stale_version' });

    await customerWrote(contacts[1]);
    await handleAppointmentJob(account, 'appointments.notify', { appointmentId: appointment.id, version: 2, kind: 'cancelled' },
      { attempts: 1, maxAttempts: 5 });
    await handleAppointmentNoticeJob(account, { appointmentId: appointment.id, version: 2, kind: 'cancelled' });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ accountId: account, contactId: contacts[1], serviceMessage: true });
    expect(await messageRow(appointment.id, 2, 'cancelled')).toEqual({ status: 'sent', reason: null });
    expect(await intent(appointmentKeys.notify(appointment.id, 2, 'cancelled'))).toEqual({ status: 'accepted' });
  });

  it('records refusals before any intent: no template outside the window, MARKETING category, consent', async () => {
    const { appointment } = await staffBook(contacts[2], new Date('2026-12-09T05:30:00Z'));
    await handleAppointmentReminderJob(account, { appointmentId: appointment.id, version: 1, kind: '24h' });
    expect(await messageRow(appointment.id, 1, 'reminder_24h')).toEqual({ status: 'blocked', reason: 'no_template' });

    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text)
      VALUES($1,$2,'appt_promo','en_US','Marketing','APPROVED','Hi {{1}} on {{2}}')`, [account, owner]);
    await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_settings SET reminder_template_name='appt_promo', reminder_template_language='en_US'`);
    await handleAppointmentReminderJob(account, { appointmentId: appointment.id, version: 1, kind: '2h' });
    expect(await messageRow(appointment.id, 1, 'reminder_2h')).toEqual({ status: 'blocked', reason: 'category' });

    // Opted out after confirmation: refused. Blocked: refused. Neither leaves an intent.
    await db.query('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [contacts[2]]);
    await handleAppointmentNoticeJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmation' });
    expect(await messageRow(appointment.id, 1, 'confirmation')).toEqual({ status: 'skipped', reason: 'opted_out' });
    const second = (await staffBook(contacts[3], new Date('2026-12-09T07:30:00Z'))).appointment;
    await db.query('UPDATE contacts SET blocked_at=now() WHERE id=$1', [contacts[3]]);
    await handleAppointmentNoticeJob(account, { appointmentId: second.id, version: 1, kind: 'confirmation' });
    expect(await messageRow(second.id, 1, 'confirmation')).toEqual({ status: 'skipped', reason: 'contact_blocked' });
    for (const [id, key] of [[appointment.id, appointmentKeys.reminder(appointment.id, 1, '24h')],
      [appointment.id, appointmentKeys.notify(appointment.id, 1, 'confirmation')], [second.id, appointmentKeys.notify(second.id, 1, 'confirmation')]])
      expect(await intent(key), id).toBeUndefined();
    // A suspended workspace sends nothing, recorded as blocked rather than uncertain.
    const third = (await staffBook(contacts[0], new Date('2026-12-09T09:30:00Z'))).appointment;
    await customerWrote(contacts[0]);
    const previous = (await db.query('SELECT status FROM account_subscriptions WHERE account_id=$1', [account])).rows[0].status as string;
    await db.query("UPDATE account_subscriptions SET status='suspended' WHERE account_id=$1", [account]);
    try {
      await handleAppointmentNoticeJob(account, { appointmentId: third.id, version: 1, kind: 'confirmation' });
    } finally {
      await db.query('UPDATE account_subscriptions SET status=$2 WHERE account_id=$1', [account, previous]);
    }
    expect(await messageRow(third.id, 1, 'confirmation')).toEqual({ status: 'blocked', reason: 'workspace_suspended' });
    expect(sends.text).not.toHaveBeenCalled();
    expect(sends.template).not.toHaveBeenCalled();
    await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE appointment_settings SET reminder_template_name=NULL, reminder_template_language=NULL`);
  });

  it('a pre-booking opt-out does not block the confirmation; an ambiguous send is recorded and never repeated', async () => {
    await db.query("UPDATE contacts SET opted_out_at=now() - interval '1 day' WHERE id=$1", [contacts[4]]);
    await customerWrote(contacts[4]);
    const { appointment } = await staffBook(contacts[4], new Date('2026-12-10T05:30:00Z'));
    sends.text.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handleAppointmentNoticeJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmation' }))
      .rejects.toBeInstanceOf(UncertainDispatchError);
    expect(await messageRow(appointment.id, 1, 'confirmation')).toEqual({ status: 'outcome_unknown', reason: 'uncertain' });
    await expect(handleAppointmentNoticeJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmation' }))
      .rejects.toBeInstanceOf(UncertainDispatchError);
    expect(sends.text).toHaveBeenCalledTimes(1);
    // The free-form confirmation carried the manage link, never into logs or webhooks.
    expect(String(sends.text.mock.calls[0][0].text)).toMatch(/\/my-booking\/[A-Za-z0-9_-]{43}/);
  });

  it('BOOK <CODE> confirms a public hold once; an unknown code falls through; a late code gets one queued reply per message', async () => {
    const { appointment: hold } = await worker((tx) => bookAppointment(tx, { accountId: account, source: 'public', serviceId: ids.service,
      locationId: ids.location, staffId: ids.s1, startAt: new Date('2026-12-11T05:30:00Z'), bookingPageId: ids.page,
      sourceRef: sourceRefs.public(ids.page, randomUUID()) }));
    const message = (await customerWrote(contacts[5], 1)).rows[0].id as string;
    const input = { accountId: account, userId: owner, contactId: contacts[5], conversationId: conversations[contacts[5]],
      messageId: message, whatsappConfigId: ids.number, code: hold.hold_code as string };
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'confirmed' });
    expect(await handleBookingCode(input)).toEqual({ handled: true, outcome: 'already_confirmed' });
    const row = (await db.query('SELECT status, contact_id, version FROM appointments WHERE id=$1', [hold.id])).rows[0];
    expect(row).toMatchObject({ status: 'confirmed', contact_id: contacts[5], version: 2 });
    expect((await jobs(hold.id)).map((j) => j.dedupe_key)).toContain(appointmentKeys.notify(hold.id, 2, 'confirmation'));

    // Ordinary text shaped like a code, or someone else's confirmed code: no reply, the bots answer.
    const wrong = { ...input, contactId: contacts[6], conversationId: conversations[contacts[6]], code: 'ZZZZZZ',
      messageId: (await customerWrote(contacts[6], 1)).rows[0].id as string };
    expect(await handleBookingCode(wrong)).toEqual({ handled: false, outcome: 'code_unknown' });
    expect(await handleBookingCode({ ...wrong, code: input.code })).toEqual({ handled: false, outcome: 'code_unknown' });
    expect((await db.query('SELECT 1 FROM jobs WHERE dedupe_key=$1', [appointmentKeys.holdReply(account, wrong.messageId)])).rows).toHaveLength(0);

    // A real hold that lapsed before the message arrived: one reply, even when the inbound job retries.
    const { appointment: lapsed } = await worker((tx) => bookAppointment(tx, { accountId: account, source: 'public', serviceId: ids.service,
      locationId: ids.location, staffId: ids.s1, startAt: new Date('2026-12-11T07:30:00Z'), bookingPageId: ids.page,
      sourceRef: sourceRefs.public(ids.page, randomUUID()) }));
    await db.query("UPDATE appointments SET hold_expires_at=now()-interval '1 hour' WHERE id=$1", [lapsed.id]);
    const late = { ...wrong, code: lapsed.hold_code as string };
    expect(await handleBookingCode(late)).toEqual({ handled: true, outcome: 'hold_expired' });
    expect(await handleBookingCode(late)).toEqual({ handled: true, outcome: 'replayed' });
    const replies = (await db.query('SELECT payload FROM jobs WHERE dedupe_key=$1', [appointmentKeys.holdReply(account, wrong.messageId)])).rows;
    expect(replies).toHaveLength(1);
    expect(replies[0].payload).toEqual({ kind: 'hold_reply', contactId: contacts[6], messageId: wrong.messageId, reason: 'hold_expired' });
    await handleAppointmentJob(account, 'appointments.notify', replies[0].payload, { attempts: 1, maxAttempts: 5 });
    await handleAppointmentJob(account, 'appointments.notify', replies[0].payload, { attempts: 2, maxAttempts: 5 });
    expect(sends.text).toHaveBeenCalledTimes(1);
    expect(sends.text.mock.calls[0][0]).toMatchObject({ contactId: contacts[6], serviceMessage: true });
  });

  it('the booked event alerts the practitioner when someone else booked, once', async () => {
    const { appointment } = await withTenant(asAdmin, (tx) => bookAppointment(tx, { accountId: account, source: 'staff', serviceId: ids.service,
      locationId: ids.location, staffId: ids.s1, contactId: contacts[7], startAt: new Date('2026-12-12T05:30:00Z'), actorUserId: owner }));
    await handleAppointmentEventJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmed' });
    await handleAppointmentEventJob(account, { appointmentId: appointment.id, version: 1, kind: 'confirmed' });
    const alerts = (await db.query("SELECT user_id, title, link FROM notifications WHERE account_id=$1 AND type='appointment_booked'", [account])).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ user_id: agent, link: `/appointments?id=${appointment.id}` });
    expect(alerts[0].title).toContain('Consult');
    expect(alerts[0].title).not.toContain('Contact');
    expect(await intent(`${appointmentKeys.event(appointment.id, 1, 'confirmed')}:automations`)).toEqual({ status: 'accepted' });
  });
});
