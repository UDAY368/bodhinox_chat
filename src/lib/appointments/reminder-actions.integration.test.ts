import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Batch 3 reminders on PostgreSQL: the reminder carries Confirm / Reschedule /
// Cancel (interactive inside the window, the approved actions template
// outside it), a tap acts only for the booking's own contact and version,
// the customer cut-off holds, and the intake form is sent once per booking.
// Meta is never called: the engine senders and the form sender are fakes.
const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), interactive: vi.fn(), form: vi.fn() }));
vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: sends.text, engineSendTemplate: sends.template, engineSendInteractive: sends.interactive,
}));
vi.mock('@/lib/whatsapp/forms/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/whatsapp/forms/send')>();
  const { dispatchOnce } = await import('@/lib/jobs/dispatch');
  // The real sendForm's durability shape: one outbound intent per key around the provider call.
  return { ...actual, sendForm: (args: { accountId: string; intentKey: string }) =>
    dispatchOnce(args.accountId, args.intentKey, () => sends.form(args)).then(() => ({ whatsappMessageId: 'wamid.form', messageId: null })) };
});

import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { bookAppointment, type BookInput } from './booking';
import { setHours, setOfferings } from './config';
import { enqueueIntakeForm, handleIntakeFormJob, intakeFormKey } from './intake-form';
import { appointmentKeys } from './keys';
import { handleReminderAction, reminderActionId, REMINDER_ACTIONS_TEMPLATE } from './reminder-actions';
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
const ids = { location: randomUUID(), service: randomUUID(), s1: randomUUID(), number: randomUUID(), form: randomUUID() };
const conversations: Record<string, string> = {};
let db: pg.Client;
let slot = 0;

/** A distinct future start on the half-hour grid (bookings never collide). */
const nextStart = () => new Date(Date.UTC(2027, 2, 1, 4, 0) + (slot++) * 3_600_000);
const staffBook = (contactId: string, startAt: Date, extra: Partial<BookInput> = {}) => withTenant(asAgent, (tx) => bookAppointment(tx, {
  accountId: account, source: 'staff', serviceId: ids.service, locationId: ids.location, staffId: ids.s1, contactId, startAt, actorUserId: agent, ...extra,
}));
const appointment = async (id: string) => (await db.query(
  'SELECT status, version, attendance_confirmed_at FROM appointments WHERE account_id=$1 AND id=$2', [account, id])).rows[0] as
  { status: string; version: number; attendance_confirmed_at: Date | null };
const events = async (id: string, kind: string) => Number((await db.query(
  'SELECT count(*)::int AS n FROM appointment_events WHERE appointment_id=$1 AND kind=$2', [id, kind])).rows[0].n);
const messageRow = async (id: string, version: number, kind: string) => (await db.query(
  'SELECT status, reason, channel FROM appointment_messages WHERE account_id=$1 AND appointment_id=$2 AND version=$3 AND kind=$4',
  [account, id, version, kind])).rows[0] as { status: string; reason: string | null; channel: string | null } | undefined;
const customerWrote = async (contactId: string, minutesAgo = 5) => (await db.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at)
   VALUES($1,$2,'customer','text','hi',now() - make_interval(mins => $3)) RETURNING id`, [account, conversations[contactId], minutesAgo])).rows[0].id as string;
const tap = async (contactId: string, replyId: string) => handleReminderAction({
  accountId: account, contactId, conversationId: conversations[contactId], messageId: await customerWrote(contactId, 0), replyId,
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('appointment reminder buttons on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Rem test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[owner, agent]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reminders A',$2)", [account, owner]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic')", [account]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent')", [account, owner, agent]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true)`, [ids.number, account, owner, `pn-${account}`]);
    await db.query(`INSERT INTO contacts(id,account_id,user_id,name,phone)
      SELECT c, $2, $3, 'Contact ' || n, '+1415777' || lpad(n::text, 4, '0') FROM unnest($1::uuid[]) WITH ORDINALITY AS t(c, n)`, [contacts, account, owner]);
    for (const contactId of contacts) {
      conversations[contactId] = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id)
        VALUES($1,$2,$3,$4) RETURNING id`, [account, owner, contactId, ids.number])).rows[0].id;
    }
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,status,category,body_text,header_type,header_content,buttons)
      VALUES($1,$2,$3,'en_US','APPROVED','Utility','Reminder: your {{1}} appointment is on {{2}} ({{3}}). Tap Confirm, Reschedule or Cancel.',
        'text','Appointment reminder',$4::jsonb)`,
    [account, owner, REMINDER_ACTIONS_TEMPLATE, JSON.stringify([{ type: 'QUICK_REPLY', text: 'Confirm' },
      { type: 'QUICK_REPLY', text: 'Reschedule' }, { type: 'QUICK_REPLY', text: 'Cancel' }])]);
    await db.query(`INSERT INTO whatsapp_forms(id,account_id,user_id,name,category,status,meta_flow_id,definition)
      VALUES($1,$2,$3,'Intake','APPOINTMENT_BOOKING','published','flow-1','{"screens":[]}'::jsonb)`, [ids.form, account, owner]);
    await withTenant(asAdmin, async (tx) => {
      await tx.$executeRaw`INSERT INTO appointment_settings(min_notice_minutes,horizon_days) VALUES(0,365)`;
      await tx.$executeRaw`INSERT INTO appointment_locations(id,name,timezone) VALUES(${ids.location}::uuid,'Clinic','Asia/Kolkata')`;
      await tx.$executeRaw`INSERT INTO appointment_services(id,name,mode,duration_minutes) VALUES(${ids.service}::uuid,'Consult','offline',30)`;
      await tx.$executeRaw`INSERT INTO appointment_staff(id,display_name,user_id) VALUES(${ids.s1}::uuid,'Dr One',${agent}::uuid)`;
      const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '00:00', end: '24:00' }]]));
      await setHours(tx, account, owner, { location_id: ids.location, staff_id: ids.s1, hours: allDay });
      await setOfferings(tx, account, owner, { service_id: ids.service, location_id: ids.location, pooled: false, staff_ids: [ids.s1] });
    });
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
    sends.interactive.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.interactive' });
    sends.form.mockReset().mockResolvedValue({ ok: true });
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

  it('inside the window the reminder carries the three action buttons for its version', async () => {
    const { appointment: a } = await staffBook(contacts[0], nextStart());
    await customerWrote(contacts[0]);
    await handleAppointmentReminderJob(account, { appointmentId: a.id, version: a.version, kind: '24h' });
    expect(sends.interactive).toHaveBeenCalledTimes(1);
    const payload = sends.interactive.mock.calls[0][0].payload;
    expect(payload.buttons.map((b: { id: string }) => b.id)).toEqual([
      reminderActionId('confirm', a.id, a.version), reminderActionId('reschedule', a.id, a.version), reminderActionId('cancel', a.id, a.version)]);
    expect(payload.body).toContain('/my-booking/');
    expect(await messageRow(a.id, a.version, 'reminder_24h')).toEqual({ status: 'sent', reason: null, channel: 'whatsapp' });
  });

  it('outside the window the approved actions template carries the ids as quick-reply payloads', async () => {
    const { appointment: a } = await staffBook(contacts[1], nextStart());
    await handleAppointmentReminderJob(account, { appointmentId: a.id, version: a.version, kind: '24h' });
    expect(sends.template).toHaveBeenCalledTimes(1);
    const args = sends.template.mock.calls[0][0];
    expect(args.templateName).toBe(REMINDER_ACTIONS_TEMPLATE);
    expect(args.messageParams.buttonParams).toEqual({
      0: reminderActionId('confirm', a.id, a.version), 1: reminderActionId('reschedule', a.id, a.version), 2: reminderActionId('cancel', a.id, a.version) });
  });

  it('an ambiguous reminder is recorded outcome_unknown and never sent again', async () => {
    const { appointment: a } = await staffBook(contacts[2], nextStart());
    await customerWrote(contacts[2]);
    sends.interactive.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handleAppointmentReminderJob(account, { appointmentId: a.id, version: a.version, kind: '24h' }))
      .rejects.toBeInstanceOf(UncertainDispatchError);
    await expect(handleAppointmentReminderJob(account, { appointmentId: a.id, version: a.version, kind: '24h' }))
      .rejects.toBeInstanceOf(UncertainDispatchError);
    expect(sends.interactive).toHaveBeenCalledTimes(1);
    expect((await messageRow(a.id, a.version, 'reminder_24h'))?.status).toBe('outcome_unknown');
  });

  it('Confirm records attendance once; another contact, a forged id and an old version change nothing', async () => {
    const { appointment: a } = await staffBook(contacts[3], nextStart());
    expect(await tap(contacts[4], reminderActionId('confirm', a.id, a.version))).toEqual({ handled: false, outcome: 'ignored' });
    expect(await tap(contacts[3], reminderActionId('confirm', randomUUID(), a.version))).toEqual({ handled: false, outcome: 'ignored' });
    expect((await tap(contacts[3], reminderActionId('confirm', a.id, a.version + 5))).outcome).toBe('stale');
    expect((await appointment(a.id)).attendance_confirmed_at).toBeNull();

    expect(await tap(contacts[3], reminderActionId('confirm', a.id, a.version))).toEqual({ handled: true, outcome: 'confirm' });
    expect(await tap(contacts[3], reminderActionId('confirm', a.id, a.version))).toEqual({ handled: true, outcome: 'already_confirmed' });
    const row = await appointment(a.id);
    expect(row.attendance_confirmed_at).not.toBeNull();
    expect(row.version).toBe(a.version);
    expect(await events(a.id, 'attendance_confirmed')).toBe(1);
    // One reply per tap (stale + two confirms), each its own intent.
    expect(sends.text).toHaveBeenCalledTimes(3);
  });

  it('Cancel within the cut-off cancels as the customer and queues the cancelled notice; Reschedule only replies', async () => {
    const { appointment: a } = await staffBook(contacts[5], nextStart());
    expect((await tap(contacts[5], reminderActionId('reschedule', a.id, a.version))).outcome).toBe('reschedule');
    expect((await appointment(a.id)).status).toBe('confirmed');
    expect(sends.text.mock.calls[0][0].text).toContain('/my-booking/');

    expect((await tap(contacts[5], reminderActionId('cancel', a.id, a.version))).outcome).toBe('cancel');
    const row = await appointment(a.id);
    expect(row).toMatchObject({ status: 'cancelled', version: a.version + 1 });
    const notice = await db.query('SELECT 1 FROM jobs WHERE tenant_id=$1 AND dedupe_key=$2',
      [account, appointmentKeys.notify(a.id, a.version + 1, 'cancelled')]);
    expect(notice.rowCount).toBe(1);
    // A replayed tap finds its own cancellation and sends nothing more.
    expect((await tap(contacts[5], reminderActionId('cancel', a.id, a.version))).outcome).toBe('already_cancelled');
    expect(sends.text).toHaveBeenCalledTimes(1);
  });

  it('Cancel past the customer cut-off leaves the booking and says so', async () => {
    const soon = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000 + 1_800_000);
    const { appointment: a } = await staffBook(contacts[6], soon);
    expect((await tap(contacts[6], reminderActionId('cancel', a.id, a.version))).outcome).toBe('too_late');
    expect((await appointment(a.id)).status).toBe('confirmed');
  });

  it('the intake form is queued and sent once per confirmed booking', async () => {
    await db.query('UPDATE appointment_services SET intake_form_id=$1 WHERE id=$2', [ids.form, ids.service]);
    try {
      const { appointment: a } = await staffBook(contacts[7], nextStart());
      await customerWrote(contacts[7]);
      expect(await enqueueIntakeForm(account, a.id, a.version)).toBe(true);
      expect(await enqueueIntakeForm(account, a.id, a.version)).toBe(false);
      expect((await handleIntakeFormJob(account, { appointmentId: a.id, version: a.version }))?.status).toBe('sent');
      expect(await handleIntakeFormJob(account, { appointmentId: a.id, version: a.version })).toBeNull();
      expect(sends.form).toHaveBeenCalledTimes(1);
      expect(sends.form.mock.calls[0][0].intentKey).toBe(intakeFormKey(a.id, a.version));
      expect(await messageRow(a.id, a.version, 'intake_form')).toEqual({ status: 'sent', reason: null, channel: 'whatsapp' });
    } finally {
      await db.query('UPDATE appointment_services SET intake_form_id=NULL WHERE id=$1', [ids.service]);
    }
  });
});
