import { createHmac, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';

// Zoom webhook and attendance evidence on PostgreSQL (Phase 9 T3): the signed
// route records each delivery once and queues one minimised job; the job writes
// append-only evidence, only ever raises attendance_evidence, never changes the
// appointment's status, ignores a session well before the appointment, opens
// one outcome task on the first meeting.ended at or after the start, ignores a
// meeting id that is not this workspace's, and app_deauthorized disconnects
// unless the connection was re-authorized after it. No Zoom call is made
// anywhere (deauthorization never calls Zoom).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
const SECRET = 'zoom-webhook-test-secret';
Object.assign(process.env, { ZOOM_ENABLED: 'true', ZOOM_CLIENT_ID: 'cid', ZOOM_CLIENT_SECRET: 'csecret', ZOOM_WEBHOOK_SECRET_TOKEN: SECRET });

const fetchSpy = vi.fn(async () => { throw new Error('no provider call expected'); });
vi.stubGlobal('fetch', fetchSpy);

import { POST } from '@/app/api/integrations/zoom/webhook/route';
import { loadManageView } from '@/app/api/public/booking/_lib/views';
import { listStaff, updateStaff } from '@/lib/appointments/config';
import { getAppointmentDetail } from '@/lib/appointments/listing';
import { withTenant } from '@/lib/db/tenant';
import { handleZoomEventJob } from './attendance';

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, ownerB];
const zoomA = `za_${randomUUID().slice(0, 8)}`, zoomB = `zb_${randomUUID().slice(0, 8)}`;
const meetingIdA = String(Math.floor(1e10 + Math.random() * 8e10)), meetingIdB = String(Math.floor(1e10 + Math.random() * 8e10));
const ids = {
  location: randomUUID(), service: randomUUID(), staff: randomUUID(), contact: randomUUID(), appointment: randomUUID(),
  connA: randomUUID(), meetingA: randomUUID(), serviceB: randomUUID(), locationB: randomUUID(), appointmentB: randomUUID(),
  connB: randomUUID(), meetingB: randomUUID(),
};
let owner: pg.Client;
let eventTs = Date.now();

function signed(body: unknown, opts: { secret?: string; timestamp?: string } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', opts.secret ?? SECRET).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return new Request('http://x/api/integrations/zoom/webhook', {
    method: 'POST', body: raw, headers: { 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature },
  });
}
function zoomEvent(event: string, zoomAccount: string, meetingId: string, participant?: Record<string, unknown>) {
  eventTs += 1000;
  return { event, event_ts: eventTs, payload: { account_id: zoomAccount, object: { id: Number(meetingId), host_id: 'HostZ', topic: 'Consult · abcdefghij',
    ...(participant ? { participant } : {}) } } };
}
/** Delivers through the route, then runs every job it queued (as the worker would). */
async function deliver(body: unknown): Promise<string> {
  const res = await POST(signed(body));
  expect(res.status).toBe(200);
  const { status } = await res.json() as { status: string };
  const jobs = await owner.query(`SELECT id, tenant_id, payload FROM jobs WHERE type='meetings.zoom_event' AND status='pending'
    AND tenant_id = ANY($1::uuid[]) ORDER BY created_at`, [[accountA, accountB]]);
  for (const job of jobs.rows) {
    await handleZoomEventJob(job.tenant_id, job.payload);
    await owner.query(`UPDATE jobs SET status='done' WHERE id=$1`, [job.id]);
  }
  return status;
}
const meetingRow = async (id = ids.meetingA) =>
  (await owner.query(`SELECT attendance_evidence, first_join_at, attended_seconds, meeting_ended_at, sync_state FROM appointment_meetings WHERE id=$1`, [id])).rows[0];
const count = async (sql: string, ...values: unknown[]) => Number((await owner.query(sql, values)).rows[0].n);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('zoom webhook and attendance evidence on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'P9 Zoom', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'P9 Zoom A',$2),($3,'P9 Zoom B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')`,
      [accountA, ownerA, agentA, accountB, ownerB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Zoom contact','14155550932')", [ids.contact, accountA, ownerA]);
    for (const [acct, loc, svc] of [[accountA, ids.location, ids.service], [accountB, ids.locationB, ids.serviceB]]) {
      await owner.query("INSERT INTO appointment_locations(id,account_id,name,timezone) VALUES($1,$2,'Clinic','Asia/Kolkata')", [loc, acct]);
      await owner.query("INSERT INTO appointment_services(id,account_id,name,mode,duration_minutes) VALUES($1,$2,'Consult','online',30)", [svc, acct]);
    }
    await owner.query("INSERT INTO appointment_staff(id,account_id,display_name,user_id) VALUES($1,$2,'Dr A',$3)", [ids.staff, accountA, agentA]);
    const appt = `INSERT INTO appointments(id,account_id,contact_id,service_id,staff_id,location_id,start_at,end_at,timezone,status,source,
        confirmed_at,service_name) VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval,now()+$7::interval+interval '30 minutes','Asia/Kolkata','confirmed',
        'staff',now(),'Consult')`;
    // A started 30 minutes ago (its session is under way); B is ahead.
    await owner.query(appt, [ids.appointment, accountA, ids.contact, ids.service, ids.staff, ids.location, '-30 minutes']);
    await owner.query(appt, [ids.appointmentB, accountB, null, ids.serviceB, null, ids.locationB, '1 hour']);
    const conn = `INSERT INTO meeting_connections(id,account_id,zoom_account_id,authorized_zoom_user_id,access_token_enc,refresh_token_enc,token_expires_at)
      VALUES($1,$2,$3,'HostZ','enc-a','enc-r',now()+interval '1 hour')`;
    await owner.query(conn, [ids.connA, accountA, zoomA]);
    await owner.query(conn, [ids.connB, accountB, zoomB]);
    const meeting = `INSERT INTO appointment_meetings(id,account_id,appointment_id,connection_id,meeting_ref,external_meeting_id,registrant_id,
      join_url,sync_state,synced_version) VALUES($1,$2,$3,$4,$5,$6,$7,'https://zoom.us/j/1','active',1)`;
    await owner.query(meeting, [ids.meetingA, accountA, ids.appointment, ids.connA, 'abcdefghij', meetingIdA, 'reg-ours']);
    await owner.query(meeting, [ids.meetingB, accountB, ids.appointmentB, ids.connB, 'klmnopqrst', meetingIdB, null]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM webhook_receipts WHERE provider='zoom' AND (payload->>'accountId') = ANY($1::text[])", [[accountA, accountB]]);
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses a bad signature or a stale timestamp and records nothing', async () => {
    const body = zoomEvent('meeting.started', zoomA, meetingIdA);
    expect((await POST(signed(body, { secret: 'wrong' }))).status).toBe(401);
    expect((await POST(signed(body, { timestamp: String(Math.floor(Date.now() / 1000) - 400) }))).status).toBe(401);
    expect(await count("SELECT count(*) AS n FROM webhook_receipts WHERE provider='zoom' AND payload->>'accountId'=$1", accountA)).toBe(0);
  });

  it('answers the url_validation challenge', async () => {
    const res = await POST(signed({ event: 'endpoint.url_validation', payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' } }));
    expect(await res.json()).toEqual({
      plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: createHmac('sha256', SECRET).update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'),
    });
  });

  it('records a duplicate delivery once and keeps one evidence row', async () => {
    const body = zoomEvent('meeting.started', zoomA, meetingIdA);
    expect(await deliver(body)).toBe('queued');
    expect(await deliver(body)).toBe('duplicate');
    expect(await count(`SELECT count(*) AS n FROM meeting_participant_events WHERE appointment_meeting_id=$1 AND kind='meeting_started'`, ids.meetingA)).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='meetings.zoom_event'`, accountA)).toBe(1);
  });

  it('raises evidence for a guest then our registrant, never lowers it, ignores the host and never changes the status', async () => {
    const base = new Date(Date.now() - 20 * 60_000);
    const iso = (min: number) => new Date(base.getTime() + min * 60_000).toISOString();
    await deliver(zoomEvent('meeting.participant_joined', zoomA, meetingIdA, { id: 'HostZ', participant_uuid: 'host-1', join_time: iso(0), user_name: 'Dr A' }));
    expect((await meetingRow()).attendance_evidence).toBe('none');
    await deliver(zoomEvent('meeting.participant_joined', zoomA, meetingIdA, { id: 'G1', participant_uuid: 'guest-1', join_time: iso(1), email: 'g@example.com' }));
    expect((await meetingRow()).attendance_evidence).toBe('guest_joined');
    await deliver(zoomEvent('meeting.participant_joined', zoomA, meetingIdA, { id: 'C1', participant_uuid: 'cust-1', registrant_id: 'reg-ours', join_time: iso(2) }));
    await deliver(zoomEvent('meeting.participant_left', zoomA, meetingIdA, { id: 'C1', participant_uuid: 'cust-1', registrant_id: 'reg-ours', leave_time: iso(12) }));
    await deliver(zoomEvent('meeting.participant_joined', zoomA, meetingIdA, { id: 'G2', participant_uuid: 'guest-2', join_time: iso(3) }));
    const row = await meetingRow();
    expect(row.attendance_evidence).toBe('registrant_joined');
    expect(new Date(row.first_join_at).toISOString()).toBe(iso(1));
    expect(row.attended_seconds).toBe(600);
    const appt = (await owner.query('SELECT status, version FROM appointments WHERE id=$1', [ids.appointment])).rows[0];
    expect(appt).toEqual({ status: 'confirmed', version: 1 });
    // One history row for the first non-host join; no participant name or email stored anywhere.
    expect(await count(`SELECT count(*) AS n FROM appointment_events WHERE appointment_id=$1 AND kind='meeting_joined_provider'`, ids.appointment)).toBe(1);
    const stored = JSON.stringify((await owner.query('SELECT * FROM meeting_participant_events WHERE appointment_meeting_id=$1', [ids.meetingA])).rows);
    for (const pii of ['Dr A', 'g@example.com', 'guest-1', 'cust-1']) expect(stored).not.toContain(pii);
    // The history-only event is never queued for fan-out.
    expect(await count(`SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='appointments.event'`, accountA)).toBe(0);
  });

  it('ignores a session well before the appointment, and an early end inside the margin opens no task', async () => {
    const startA = (await owner.query('SELECT start_at FROM appointments WHERE id=$1', [ids.appointment])).rows[0].start_at as Date;
    const before = await count('SELECT count(*) AS n FROM meeting_participant_events WHERE appointment_meeting_id=$1', ids.meetingA);
    // The host's test session the day before: nothing recorded.
    await deliver({ ...zoomEvent('meeting.participant_joined', zoomA, meetingIdA, { id: 'G9', participant_uuid: 'early-1',
      join_time: new Date(startA.getTime() - 24 * 3600_000).toISOString() }) });
    await deliver({ ...zoomEvent('meeting.ended', zoomA, meetingIdA), event_ts: startA.getTime() - 24 * 3600_000 });
    expect(await count('SELECT count(*) AS n FROM meeting_participant_events WHERE appointment_meeting_id=$1', ids.meetingA)).toBe(before);
    expect((await meetingRow()).meeting_ended_at).toBeNull();
    // A test ten minutes before the start: recorded, but the outcome task waits for an end at or after the start.
    await deliver({ ...zoomEvent('meeting.ended', zoomA, meetingIdA), event_ts: startA.getTime() - 10 * 60_000 });
    expect(new Date((await meetingRow()).meeting_ended_at).getTime()).toBe(startA.getTime() - 10 * 60_000);
    expect(await count(`SELECT count(*) AS n FROM tasks WHERE appointment_id=$1 AND kind='meeting_outcome'`, ids.appointment)).toBe(0);
  });

  it('stamps the latest meeting.ended and opens exactly one outcome task, even when the end is sent again', async () => {
    const early = new Date((await meetingRow()).meeting_ended_at).getTime();
    await deliver(zoomEvent('meeting.ended', zoomA, meetingIdA));
    await deliver(zoomEvent('meeting.ended', zoomA, meetingIdA));
    const row = await meetingRow();
    expect(new Date(row.meeting_ended_at).getTime()).toBeGreaterThan(early);
    const tasks = (await owner.query(`SELECT kind, status, assigned_to FROM tasks WHERE appointment_id=$1 AND kind='meeting_outcome'`, [ids.appointment])).rows;
    expect(tasks).toEqual([{ kind: 'meeting_outcome', status: 'open', assigned_to: agentA }]);
    // Staff closing the task and a third end do not open another.
    await owner.query(`UPDATE tasks SET status='done' WHERE appointment_id=$1 AND kind='meeting_outcome'`, [ids.appointment]);
    await deliver(zoomEvent('meeting.ended', zoomA, meetingIdA));
    expect(await count(`SELECT count(*) AS n FROM tasks WHERE appointment_id=$1 AND kind='meeting_outcome'`, ids.appointment)).toBe(1);
    expect((await owner.query('SELECT status FROM appointments WHERE id=$1', [ids.appointment])).rows[0].status).toBe('confirmed');
  });

  it('ignores a meeting id of another workspace sent under this workspace\'s Zoom account', async () => {
    const before = await count('SELECT count(*) AS n FROM meeting_participant_events WHERE account_id = ANY($1::uuid[])', [accountA, accountB]);
    await deliver(zoomEvent('meeting.participant_joined', zoomA, meetingIdB, { id: 'X', participant_uuid: 'x-1', join_time: new Date().toISOString() }));
    expect(await count('SELECT count(*) AS n FROM meeting_participant_events WHERE account_id = ANY($1::uuid[])', [accountA, accountB])).toBe(before);
    expect((await meetingRow(ids.meetingB)).attendance_evidence).toBe('none');
  });

  it('acknowledges an event for an unknown Zoom account without queuing', async () => {
    expect(await deliver(zoomEvent('meeting.started', 'unknown_acct', meetingIdA))).toBe('ignored');
  });

  it('shows agents the meeting view without the registrant id, and viewers nothing', async () => {
    const detail = await withTenant({ accountId: accountA, userId: agentA, role: 'agent' }, (tx) => getAppointmentDetail(tx, accountA, ids.appointment));
    expect(detail.meeting).toMatchObject({ sync_state: 'active', join_url: 'https://zoom.us/j/1', attendance_evidence: 'registrant_joined' });
    expect(JSON.stringify(detail.meeting)).not.toContain('reg-ours');
  });

  it('lets an admin set and clear a practitioner Zoom host email', async () => {
    const asAdmin = { accountId: accountA, userId: ownerA, role: 'admin' as const };
    const set = await withTenant(asAdmin, (tx) => updateStaff(tx, accountA, ownerA, ids.staff, { meeting_host_email: ' Host@Clinic.Example ' }));
    expect(set.meeting_host_email).toBe('host@clinic.example');
    await expect(withTenant(asAdmin, (tx) => updateStaff(tx, accountA, ownerA, ids.staff, { meeting_host_email: 'not-an-email' })))
      .rejects.toMatchObject({ field: 'meeting_host_email' });
    const cleared = await withTenant(asAdmin, (tx) => updateStaff(tx, accountA, ownerA, ids.staff, { meeting_host_email: '' }));
    expect(cleared.meeting_host_email).toBeNull();
    expect((await withTenant(asAdmin, (tx) => listStaff(tx, accountA)))[0]).toMatchObject({ id: ids.staff, meeting_host_email: null });
  });

  it('treats an online service as online on the customer page before any link exists', async () => {
    const view = await withTenant({ accountId: accountB, role: 'owner' }, (tx) => loadManageView(tx, accountB, ids.appointmentB));
    expect(view).toMatchObject({ online: true, meetingUrl: null, meetingLinkLater: false });
  });

  it('keeps a connection re-authorized after a delayed app_deauthorized, and disconnects on a current one', async () => {
    const connB = async () => (await owner.query('SELECT status, access_token_enc FROM meeting_connections WHERE id=$1', [ids.connB])).rows[0];
    // The admin uninstalled, then reconnected (connected_at=now) before the queued event ran.
    await owner.query("UPDATE meeting_connections SET connected_at=now() WHERE id=$1", [ids.connB]);
    await deliver({ event: 'app_deauthorized', event_ts: Date.now() - 60_000, payload: { account_id: zoomB, user_id: 'HostZ', client_id: 'cid' } });
    expect(await connB()).toEqual({ status: 'active', access_token_enc: 'enc-a' });
    expect((await meetingRow(ids.meetingB)).sync_state).toBe('active');

    await owner.query("UPDATE meeting_connections SET connected_at=now()-interval '1 hour' WHERE id=$1", [ids.connB]);
    await deliver({ event: 'app_deauthorized', event_ts: Date.now(), payload: { account_id: zoomB, user_id: 'HostZ', client_id: 'cid' } });
    expect(await connB()).toEqual({ status: 'disconnected', access_token_enc: null });
    expect((await meetingRow(ids.meetingB)).sync_state).toBe('detached');
    expect((await owner.query(`SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='integrations.zoom_disconnect'`,
      [accountB])).rows).toEqual([{ user_id: null, metadata: { reason: 'deauthorized', revoke: 'skipped', detached: 1 } }]);
  });

  it('never called Zoom', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
