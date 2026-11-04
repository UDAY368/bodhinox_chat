// Appointment meeting sync (Phase 9, design §2 "Appointment meeting"). Owner: T2.
//
// One Zoom meeting per online appointment, created by the worker only when the
// appointment is confirmed and in the future, the service is online, the
// workspace connected Zoom, the deployment has the Zoom config and the plan
// has online_meetings. Nothing here runs without all of them.
//
// Each pass: read the target and the meeting row (no lock) to decide whether
// Zoom must be called; get a token; claim the row in a short worker
// transaction (appointment row, then meeting row: D16); call Zoom OUTSIDE any
// transaction; write the result only WHERE claim_token = mine. An ambiguous
// create (5xx, timeout, crash after the claim) is reconciled by meeting_ref,
// which is in the topic, and never re-created. After a successful write the
// target is re-read once more (two passes at most), so a cancel that arrived
// while a create was in flight deletes the new meeting instead of orphaning it.
//
// Row states (CHECK in 20261108100000_meeting_integration): `creating` with an
// active claim = a call is in flight; `creating` without a claim and
// last_error_code 'throttled' or 'not_sent' = no meeting was made (a 429, a
// staff "Create again" or a re-host), so it is created; any other unclaimed
// `creating` = a crash after the claim, so it is reconciled like `unknown`.
import { randomInt, randomUUID } from 'node:crypto';
import { getEntitlements } from '@/lib/billing/entitlements';
import { appointmentKeys } from '@/lib/appointments/keys';
import { openSystemTask } from '@/lib/appointments/tasks';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx } from '@/lib/payments/ledger';
import { zoomConfig } from './config';
import { getZoomAccessToken, markZoomTokenRejected, renewZoomAccessToken } from './connection';
import { backfillMeetingSyncTx, insertMeetingSyncJob as insertSyncJob } from './jobs';
import {
  MeetingError, type MeetingActor, type MeetingJobMeta, type MeetingSyncPayload, type MeetingSyncState,
} from './types';
import { zoomCall, ZoomError, type ZoomMethod } from './zoom-client';

/** The appointment fields enqueueMeetingSync needs (an AppointmentRow fits). */
export interface MeetingSyncTarget {
  id: string;
  service_id: string;
  status: string;
}

/** Longer than the 15 s Zoom timeout plus the result write. */
const CLAIM_MS = 60_000;
/** Codes on an unclaimed `creating` row that prove no meeting was made. */
const NOT_SENT = new Set(['throttled', 'not_sent']);
const LIVE_STATES: readonly MeetingSyncState[] = ['creating', 'active', 'unknown'];
const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Reconcile reads at most this many pages of the host's scheduled meetings. */
const RECONCILE_MAX_PAGES = 10;
const SWEEP_BATCH = 50;
const ZOOM_MEETING_ID = /^[0-9]{1,20}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** A retryable condition (claim busy, throttled, ambiguous): the job backs off and runs again. */
export class MeetingSyncRetry extends Error {
  constructor(readonly reason: string) {
    super(`meeting_sync_retry:${reason}`);
    this.name = 'MeetingSyncRetry';
  }
}

export function newMeetingRef(): string {
  let ref = '';
  for (let i = 0; i < 10; i++) ref += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return ref;
}

/** `<service name> · <meeting_ref>`: never a customer name, phone or email. */
export function meetingTopic(serviceName: string, ref: string): string {
  const name = serviceName.replace(/\s+/g, ' ').trim().slice(0, 150) || 'Appointment';
  return `${name} · ${ref}`;
}

/** Zoom's start_time form: UTC without milliseconds. */
const zoomTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function asWorker<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());
}

// ---------------------------------------------------------------------------
// Enqueue (inside the booking transaction)

/**
 * Inserts the appointments.meeting_sync job (dedupe appointmentKeys.meetingSync)
 * in the caller's transaction, only when the service is online, the workspace
 * has a live connection, the deployment has the Zoom config and the plan has
 * online_meetings (or a meeting row already exists that must follow the change).
 * Returns whether a job was queued. Never makes a provider call, and runs no
 * query at all while Zoom is not configured.
 */
export async function enqueueMeetingSync(
  tx: TenantTransaction, accountId: string, row: MeetingSyncTarget, version: number,
): Promise<boolean> {
  if (!zoomConfig()) return false;
  const [r] = await tx.$queryRaw<{ mode: string; connected: boolean; has_meeting: boolean }[]>`SELECT s.mode,
      EXISTS (SELECT 1 FROM meeting_connections c WHERE c.account_id=${accountId}::uuid AND c.status='active') AS connected,
      EXISTS (SELECT 1 FROM appointment_meetings m WHERE m.account_id=${accountId}::uuid AND m.appointment_id=${row.id}::uuid
        AND m.sync_state IN ('creating','active','unknown')) AS has_meeting
    FROM appointment_services s WHERE s.account_id=${accountId}::uuid AND s.id=${row.service_id}::uuid`;
  if (!r) return false;
  let wanted = r.has_meeting;
  if (!wanted && row.status === 'confirmed' && r.mode === 'online' && r.connected)
    wanted = (await getEntitlements(tx, accountId)).features.online_meetings;
  if (!wanted) return false;
  return insertSyncJob(tx, accountId, row.id, version, appointmentKeys.meetingSync(row.id, version));
}

// ---------------------------------------------------------------------------
// Snapshot and decision

interface MeetingRow {
  id: string;
  connection_id: string;
  meeting_ref: string;
  host_zoom_user: string | null;
  external_meeting_id: string | null;
  join_url: string | null;
  supplied_url: string | null;
  sync_state: MeetingSyncState;
  claim_token: string | null;
  claimed_until: Date | null;
  synced_version: number | null;
  synced_start_at: Date | null;
  synced_duration_min: number | null;
  last_error_code: string | null;
}

interface Snapshot {
  appt: {
    id: string; status: string; version: number; start_at: Date; end_at: Date; timezone: string; contact_id: string | null;
    meeting_url: string | null; service_name: string; mode: string; host_email: string | null; contact_email: string | null;
  };
  conn: { id: string; status: string; authorized_zoom_user_id: string | null; register_attendees: boolean } | null;
  meeting: MeetingRow | null;
  entitled: boolean;
}

async function loadSnapshot(tx: TenantTransaction, accountId: string, appointmentId: string, lock: boolean): Promise<Snapshot | null> {
  const lockClause = lock ? 'FOR UPDATE OF a' : '';
  const [appt] = await tx.$queryRawUnsafe<Snapshot['appt'][]>(
    `SELECT a.id::text AS id, a.status, a.version, a.start_at, a.end_at, a.timezone, a.contact_id::text AS contact_id, a.meeting_url,
       a.service_name, s.mode, st.meeting_host_email AS host_email, c.email AS contact_email
     FROM appointments a
     JOIN appointment_services s ON s.account_id=a.account_id AND s.id=a.service_id
     LEFT JOIN appointment_staff st ON st.account_id=a.account_id AND st.id=a.staff_id
     LEFT JOIN contacts c ON c.account_id=a.account_id AND c.id=a.contact_id
     WHERE a.account_id=$1::uuid AND a.id=$2::uuid ${lockClause}`, accountId, appointmentId);
  if (!appt) return null;
  const [meeting] = await tx.$queryRawUnsafe<MeetingRow[]>(
    `SELECT id::text AS id, connection_id::text AS connection_id, meeting_ref, host_zoom_user, external_meeting_id, join_url,
       supplied_url, sync_state, claim_token::text AS claim_token, claimed_until, synced_version, synced_start_at,
       synced_duration_min, last_error_code
     FROM appointment_meetings WHERE account_id=$1::uuid AND appointment_id=$2::uuid ${lock ? 'FOR UPDATE' : ''}`,
    accountId, appointmentId);
  const [conn] = await tx.$queryRaw<NonNullable<Snapshot['conn']>[]>`SELECT id::text AS id, status, authorized_zoom_user_id,
      register_attendees FROM meeting_connections WHERE account_id=${accountId}::uuid AND status<>'disconnected' LIMIT 1`;
  const entitled = meeting ? true : (await getEntitlements(tx, accountId)).features.online_meetings;
  return { appt, conn: conn ?? null, meeting: meeting ?? null, entitled };
}

type Plan =
  | { kind: 'none' }
  | { kind: 'busy' }
  | { kind: 'detach' }
  | { kind: 'abandon' }
  | { kind: 'mark_synced' }
  | { kind: 'create'; fresh: boolean }
  | { kind: 'reconcile' }
  | { kind: 'patch' }
  | { kind: 'delete'; rehost: boolean };

const needsZoom = (p: Plan): p is Extract<Plan, { kind: 'create' | 'reconcile' | 'patch' | 'delete' }> =>
  p.kind === 'create' || p.kind === 'reconcile' || p.kind === 'patch' || p.kind === 'delete';

const durationMin = (s: Snapshot) =>
  Math.min(1440, Math.max(1, Math.round((s.appt.end_at.getTime() - s.appt.start_at.getTime()) / 60_000)));

/** The Zoom user to host this appointment: the practitioner's host email, else the authorizing user. */
const hostFor = (s: Snapshot) => s.appt.host_email ?? s.conn?.authorized_zoom_user_id ?? 'me';

function decide(s: Snapshot, now: Date): Plan {
  const m = s.meeting;
  const live = !!m && LIVE_STATES.includes(m.sync_state);
  if (!s.conn) return live ? { kind: 'detach' } : { kind: 'none' };
  if (m && live && m.connection_id !== s.conn.id) return { kind: 'detach' };
  // token_invalid: nothing can be called until an admin reconnects (same Zoom account keeps the row).
  if (s.conn.status !== 'active') return { kind: 'none' };
  if (m?.claimed_until && m.claimed_until.getTime() > now.getTime()) return { kind: 'busy' };
  const a = s.appt;
  const target = a.status === 'confirmed' && a.start_at.getTime() > now.getTime() && a.mode === 'online' ? 'exists'
    : a.status === 'cancelled' || a.status === 'expired' ? 'gone' : 'leave';
  if (!m) return target === 'exists' && s.entitled ? { kind: 'create', fresh: true } : { kind: 'none' };
  switch (m.sync_state) {
    case 'creating':
      if (m.last_error_code && NOT_SENT.has(m.last_error_code))
        return target === 'exists' ? { kind: 'create', fresh: false } : { kind: 'abandon' };
      return { kind: 'reconcile' };
    case 'unknown':
      return { kind: 'reconcile' };
    case 'active': {
      if (target === 'gone') return { kind: 'delete', rehost: false };
      if (target !== 'exists') return { kind: 'none' };
      if (m.host_zoom_user !== hostFor(s)) return { kind: 'delete', rehost: true };
      if (m.synced_start_at?.getTime() !== a.start_at.getTime() || m.synced_duration_min !== durationMin(s)) return { kind: 'patch' };
      if ((m.synced_version ?? 0) < a.version) return { kind: 'mark_synced' };
      return { kind: 'none' };
    }
    default:
      // failed, manual, deleted, detached: only staff actions move these.
      return { kind: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Writes shared by the steps

async function event(tx: TenantTransaction, appointmentId: string, version: number,
  kind: 'meeting_created' | 'meeting_updated' | 'meeting_deleted' | 'meeting_sync_failed', detail: string | null = null) {
  await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor,detail)
    VALUES(${appointmentId}::uuid,${version},${kind},'system',${detail})`;
}

async function lockAppointmentVersion(tx: TenantTransaction, accountId: string, appointmentId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM appointments
    WHERE account_id=${accountId}::uuid AND id=${appointmentId}::uuid FOR UPDATE`;
  return row?.version ?? 1;
}

/** Clears my claim (the state stays); `code` replaces last_error_code when given. */
async function release(accountId: string, meetingId: string, claim: string, code?: string) {
  await asWorker(accountId, (tx) => tx.$executeRaw`UPDATE appointment_meetings SET claim_token=NULL, claimed_until=NULL,
      last_error_code=COALESCE(${code ?? null}, last_error_code), updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${meetingId}::uuid AND claim_token=${claim}::uuid`);
}

/** The step failed definitely: `failed`, one open task, one history event. */
async function writeFailed(accountId: string, w: Work, code: string) {
  await asWorker(accountId, async (tx) => {
    const version = await lockAppointmentVersion(tx, accountId, w.snap.appt.id);
    const n = await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='failed', last_error_code=${code},
        claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`;
    if (!n) return;
    await openSystemTask(tx, accountId, { kind: 'meeting_sync', appointmentId: w.snap.appt.id });
    await event(tx, w.snap.appt.id, version, 'meeting_sync_failed', code);
  });
}

/** The create may or may not have happened: `unknown`; the last attempt opens the staff task instead of retrying. */
async function writeUnknown(accountId: string, w: Work, meta: MeetingJobMeta, code: string): Promise<boolean> {
  const final = meta.attempts >= meta.maxAttempts;
  await asWorker(accountId, async (tx) => {
    await lockAppointmentVersion(tx, accountId, w.snap.appt.id);
    const n = await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='unknown', last_error_code=${code},
        claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`;
    if (n && final) await openSystemTask(tx, accountId, { kind: 'meeting_sync', appointmentId: w.snap.appt.id });
  });
  if (final) return false;
  throw new MeetingSyncRetry(code);
}

/** Zoom's numeric code as a last_error_code (CHECK ^[a-z0-9_]{1,64}$). */
const zoomCode = (e: ZoomError) => (e.code && /^[a-z0-9_]{1,40}$/.test(e.code) ? `zoom_${e.code}` : `zoom_${e.status ?? 'error'}`);

// ---------------------------------------------------------------------------
// One pass

interface Work {
  plan: Extract<Plan, { kind: 'create' | 'reconcile' | 'patch' | 'delete' }>;
  meetingId: string;
  claim: string;
  ref: string;
  host: string;
  snap: Snapshot;
  token: string;
  connectionId: string;
  /** Set once a 401 led to a renewed token: a second 401 means the grant was withdrawn. */
  renewed?: boolean;
}

/**
 * zoomCall with the step's token. The first 401 renews the token once (the
 * cached one may be stale or rotated by a reconnect) and repeats the call;
 * a 401 has no effect at Zoom, so repeating it is safe. A renewal that cannot
 * reach Zoom retries the job; one refused by Zoom (invalid_grant, now
 * recorded) or a disconnect meanwhile surfaces the original 401.
 */
async function call<T = unknown>(accountId: string, w: Work, method: ZoomMethod, path: string, body?: unknown,
  query?: Record<string, string>): Promise<T> {
  try {
    return await zoomCall<T>(w.token, method, path, body, query);
  } catch (error) {
    if (!(error instanceof ZoomError) || error.kind !== 'auth' || w.renewed) throw error;
    w.renewed = true;
    try {
      w.token = await renewZoomAccessToken(accountId, w.connectionId, w.token);
    } catch (renewal) {
      if (renewal instanceof MeetingError && (renewal.code === 'auth' || renewal.code === 'not_connected')) throw error;
      throw new MeetingSyncRetry('token_unavailable');
    }
    return zoomCall<T>(w.token, method, path, body, query);
  }
}

/** Claims the row for `plan` (or applies a write-only plan). Null when nothing is left to call Zoom for. */
async function claimOrApply(accountId: string, appointmentId: string, connectionId: string, token: string): Promise<Work | null> {
  return asWorker(accountId, async (tx) => {
    const snap = await loadSnapshot(tx, accountId, appointmentId, true);
    if (!snap) return null;
    const plan = decide(snap, new Date());
    const m = snap.meeting;
    if (plan.kind === 'busy') throw new MeetingSyncRetry('claim_busy');
    if (plan.kind === 'detach' && m) {
      await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='detached', claim_token=NULL, claimed_until=NULL, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${m.id}::uuid`;
      return null;
    }
    if (plan.kind === 'abandon' && m) {
      // No meeting was ever made and none is wanted now.
      await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='deleted', claim_token=NULL, claimed_until=NULL, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${m.id}::uuid`;
      return null;
    }
    if (plan.kind === 'mark_synced' && m) {
      await tx.$executeRaw`UPDATE appointment_meetings SET synced_version=${snap.appt.version}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${m.id}::uuid`;
      return null;
    }
    if (!needsZoom(plan) || !snap.conn || snap.conn.id !== connectionId) return null;
    const claim = randomUUID();
    const until = new Date(Date.now() + CLAIM_MS);
    const host = plan.kind === 'create' ? hostFor(snap) : (m?.host_zoom_user ?? hostFor(snap));
    if (plan.kind === 'create' && plan.fresh) {
      const ref = newMeetingRef();
      // Recorded before the POST: host_zoom_user tells reconcile whose meetings to list.
      const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO appointment_meetings(account_id, appointment_id, connection_id,
          provider, meeting_ref, host_zoom_user, supplied_url, sync_state, claim_token, claimed_until)
        VALUES(${accountId}::uuid, ${appointmentId}::uuid, ${connectionId}::uuid, 'zoom', ${ref}, ${host},
          ${snap.appt.meeting_url}, 'creating', ${claim}::uuid, ${until})
        RETURNING id::text AS id`;
      return { plan, meetingId: row.id, claim, ref, host, snap, token, connectionId };
    }
    if (!m) return null;
    await tx.$executeRaw`UPDATE appointment_meetings SET claim_token=${claim}::uuid, claimed_until=${until},
        host_zoom_user=${host}, last_error_code=CASE WHEN ${plan.kind === 'create'} THEN NULL ELSE last_error_code END, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${m.id}::uuid`;
    return { plan, meetingId: m.id, claim, ref: m.meeting_ref, host, snap, token, connectionId };
  });
}

interface ZoomMeeting {
  id?: unknown;
  topic?: unknown;
  join_url?: unknown;
  start_time?: unknown;
  duration?: unknown;
}

const meetingId = (m: ZoomMeeting) =>
  typeof m.id === 'number' && Number.isSafeInteger(m.id) ? String(m.id) : typeof m.id === 'string' && ZOOM_MEETING_ID.test(m.id) ? m.id : null;
const httpsUrl = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') && v.length <= 2048 ? v : null);

/** Writes an adopted or created meeting as `active` and points the appointment at its join link. */
async function writeActive(accountId: string, w: Work, found: {
  externalId: string; joinUrl: string; startAt: Date | null; duration: number | null; registrantId: string | null;
  code: string | null; adopted: boolean;
}): Promise<boolean> {
  return asWorker(accountId, async (tx) => {
    const version = await lockAppointmentVersion(tx, accountId, w.snap.appt.id);
    const n = await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='active', external_meeting_id=${found.externalId},
        join_url=${found.joinUrl}, registrant_id=${found.registrantId}, synced_version=${found.adopted ? null : w.snap.appt.version},
        synced_start_at=${found.startAt}, synced_duration_min=${found.duration}, last_error_code=${found.code},
        claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`;
    if (!n) return false;
    await tx.$executeRaw`UPDATE appointments SET meeting_url=${found.joinUrl}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.snap.appt.id}::uuid`;
    await event(tx, w.snap.appt.id, version, 'meeting_created', found.adopted ? 'adopted' : null);
    return true;
  });
}

/** Handles the ZoomError of a step: throttled and ambiguous retry, 401 stops, the rest is the step's own concern. */
async function common(accountId: string, w: Work, error: unknown): Promise<'handled' | ZoomError> {
  if (!(error instanceof ZoomError)) {
    // A token renewal that could not reach Zoom follows a 401, so a create was not sent.
    const notSent = error instanceof MeetingSyncRetry && error.reason === 'token_unavailable' && w.plan.kind === 'create';
    await release(accountId, w.meetingId, w.claim, notSent ? 'not_sent' : undefined);
    throw error;
  }
  if (error.kind === 'throttled') {
    await release(accountId, w.meetingId, w.claim, w.plan.kind === 'create' ? 'throttled' : undefined);
    throw new MeetingSyncRetry('throttled');
  }
  if (error.kind === 'auth') {
    await release(accountId, w.meetingId, w.claim, w.plan.kind === 'create' ? 'not_sent' : undefined);
    // Only while the connection still holds the token Zoom refused: a reconnect or refresh meanwhile wins.
    await markZoomTokenRejected(accountId, w.connectionId, w.token);
    return 'handled';
  }
  return error;
}

async function doCreate(accountId: string, w: Work, meta: MeetingJobMeta): Promise<boolean> {
  const { appt, conn } = w.snap;
  const email = conn?.register_attendees && appt.contact_email && EMAIL.test(appt.contact_email.trim()) ? appt.contact_email.trim() : null;
  const duration = durationMin(w.snap);
  let created: ZoomMeeting;
  try {
    created = await call<ZoomMeeting>(accountId, w, 'POST', `/users/${encodeURIComponent(w.host)}/meetings`, {
      topic: meetingTopic(appt.service_name, w.ref),
      type: 2,
      start_time: zoomTime(appt.start_at),
      duration,
      timezone: appt.timezone,
      settings: {
        join_before_host: false,
        waiting_room: true,
        // 0 = automatic approval (needed for registrants); 2 = no registration.
        approval_type: email ? 0 : 2,
        registrants_email_notification: false,
        registrants_confirmation_email: false,
      },
    }) ?? {};
  } catch (error) {
    const e = await common(accountId, w, error);
    if (e === 'handled') return false;
    if (e.kind === 'rejected') { await writeFailed(accountId, w, zoomCode(e)); return false; }
    return writeUnknown(accountId, w, meta, 'create_unknown');
  }
  const externalId = meetingId(created);
  const joinUrl = httpsUrl(created.join_url);
  // A 2xx we cannot read: the meeting exists but we cannot name it; reconcile by its ref.
  if (!externalId || !joinUrl) return writeUnknown(accountId, w, meta, 'create_unreadable');

  let registrantId: string | null = null;
  let personalUrl: string | null = null;
  let code: string | null = null;
  if (email) {
    try {
      // Never the customer's name: Zoom needs a first name, so a fixed placeholder.
      const reg = await call<{ registrant_id?: unknown; join_url?: unknown }>(accountId, w, 'POST',
        `/meetings/${externalId}/registrants`, { email, first_name: 'Guest' });
      registrantId = typeof reg?.registrant_id === 'string' && reg.registrant_id.length <= 128 ? reg.registrant_id : null;
      personalUrl = httpsUrl(reg?.join_url);
      if (!registrantId || !personalUrl) { registrantId = null; personalUrl = null; code = 'registration_unavailable'; }
    } catch {
      code = 'registration_unavailable';
    }
  }
  return writeActive(accountId, w, {
    externalId, joinUrl: personalUrl ?? joinUrl, startAt: appt.start_at, duration, registrantId, code, adopted: false,
  });
}

/** Lists the host's scheduled meetings for the one whose topic ends with ` · <ref>`; never creates. */
async function doReconcile(accountId: string, w: Work, meta: MeetingJobMeta): Promise<boolean> {
  const suffix = ` · ${w.ref}`;
  let match: ZoomMeeting | null = null;
  try {
    let pageToken = '';
    for (let page = 0; page < RECONCILE_MAX_PAGES && !match; page++) {
      const query: Record<string, string> = { type: 'scheduled', page_size: '300' };
      if (pageToken) query.next_page_token = pageToken;
      const list = await call<{ meetings?: ZoomMeeting[]; next_page_token?: unknown }>(accountId, w, 'GET',
        `/users/${encodeURIComponent(w.host)}/meetings`, undefined, query);
      match = (Array.isArray(list?.meetings) ? list.meetings : []).find((m) => typeof m.topic === 'string' && m.topic.endsWith(suffix)) ?? null;
      pageToken = typeof list?.next_page_token === 'string' ? list.next_page_token : '';
      if (!pageToken) break;
    }
  } catch (error) {
    const e = await common(accountId, w, error);
    if (e === 'handled') return false;
    // A definite 4xx on the list (for example the host left the account) finds nothing.
    if (e.kind === 'unknown') {
      await release(accountId, w.meetingId, w.claim);
      throw new MeetingSyncRetry('reconcile_unreachable');
    }
  }
  const externalId = match ? meetingId(match) : null;
  const joinUrl = match ? httpsUrl(match.join_url) : null;
  if (!match || !externalId || !joinUrl) return writeUnknown(accountId, w, meta, 'create_unknown');
  const start = typeof match.start_time === 'string' ? new Date(match.start_time) : null;
  const duration = typeof match.duration === 'number' && match.duration >= 1 && match.duration <= 1440 ? Math.round(match.duration) : null;
  // Adopted: the next pass patches it to the current time if it differs.
  return writeActive(accountId, w, {
    externalId, joinUrl, startAt: start && !Number.isNaN(start.getTime()) ? start : null, duration, registrantId: null,
    code: null, adopted: true,
  });
}

async function doPatch(accountId: string, w: Work): Promise<boolean> {
  const m = w.snap.meeting as MeetingRow;
  const duration = durationMin(w.snap);
  try {
    await call(accountId, w, 'PATCH', `/meetings/${m.external_meeting_id}`, {
      start_time: zoomTime(w.snap.appt.start_at), duration, timezone: w.snap.appt.timezone,
    });
  } catch (error) {
    const e = await common(accountId, w, error);
    if (e === 'handled') return false;
    if (e.kind === 'rejected') { await writeFailed(accountId, w, e.status === 404 ? 'meeting_missing' : zoomCode(e)); return false; }
    // PATCH is idempotent: the job simply retries.
    await release(accountId, w.meetingId, w.claim);
    throw new MeetingSyncRetry('patch_unknown');
  }
  return asWorker(accountId, async (tx) => {
    const version = await lockAppointmentVersion(tx, accountId, w.snap.appt.id);
    const n = await tx.$executeRaw`UPDATE appointment_meetings SET synced_version=${w.snap.appt.version},
        synced_start_at=${w.snap.appt.start_at}, synced_duration_min=${duration}, last_error_code=NULL,
        claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`;
    if (!n) return false;
    await event(tx, w.snap.appt.id, version, 'meeting_updated');
    return true;
  });
}

async function doDelete(accountId: string, w: Work, rehost: boolean): Promise<boolean> {
  const m = w.snap.meeting as MeetingRow;
  if (m.external_meeting_id) {
    try {
      await call(accountId, w, 'DELETE', `/meetings/${m.external_meeting_id}`, undefined, { schedule_for_reminder: 'false' });
    } catch (error) {
      const e = await common(accountId, w, error);
      if (e === 'handled') return false;
      // 404: already gone, which is what we wanted.
      if (!(e.kind === 'rejected' && e.status === 404)) {
        if (e.kind === 'rejected') { await writeFailed(accountId, w, zoomCode(e)); return false; }
        await release(accountId, w.meetingId, w.claim);
        throw new MeetingSyncRetry('delete_unknown');
      }
    }
  }
  return asWorker(accountId, async (tx) => {
    const version = await lockAppointmentVersion(tx, accountId, w.snap.appt.id);
    const n = rehost
      // The next pass creates the meeting under the new host with a fresh reference.
      ? await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='creating', meeting_ref=${newMeetingRef()},
          external_meeting_id=NULL, join_url=NULL, registrant_id=NULL, synced_version=NULL, synced_start_at=NULL,
          synced_duration_min=NULL, last_error_code='not_sent', claim_token=NULL, claimed_until=NULL, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`
      : await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='deleted', claim_token=NULL, claimed_until=NULL,
          last_error_code=NULL, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${w.meetingId}::uuid AND claim_token=${w.claim}::uuid`;
    if (!n) return false;
    // The deleted meeting's link no longer works: fall back to the link the service supplied.
    await tx.$executeRaw`UPDATE appointments SET meeting_url=${m.supplied_url}, updated_at=now()
      WHERE account_id=${accountId}::uuid AND id=${w.snap.appt.id}::uuid AND meeting_url IS NOT DISTINCT FROM ${m.join_url}`;
    if (!rehost) await event(tx, w.snap.appt.id, version, 'meeting_deleted');
    return rehost;
  });
}

type PassResult = { again: boolean; adopted?: boolean };

async function runPass(accountId: string, appointmentId: string, minVersion: number | null, meta: MeetingJobMeta,
  only?: 'reconcile'): Promise<PassResult> {
  const pre = await asWorker(accountId, (tx) => loadSnapshot(tx, accountId, appointmentId, false));
  if (!pre) return { again: false };
  if (minVersion !== null && minVersion < pre.appt.version) return { again: false };
  const plan = decide(pre, new Date());
  if (plan.kind === 'none') return { again: false };
  if (plan.kind === 'busy') throw new MeetingSyncRetry('claim_busy');
  if (only && plan.kind !== only) return { again: false };
  let token = '';
  const connectionId = pre.conn?.id ?? '';
  if (needsZoom(plan)) {
    try {
      token = await getZoomAccessToken(accountId, connectionId);
    } catch (error) {
      // token_invalid (now recorded) or disconnected meanwhile: nothing to do until an admin reconnects.
      if (error instanceof MeetingError && (error.code === 'auth' || error.code === 'not_connected')) return { again: false };
      throw new MeetingSyncRetry('token_unavailable');
    }
  }
  const work = await claimOrApply(accountId, appointmentId, connectionId, token);
  if (!work) return { again: false };
  if (only && work.plan.kind !== only) {
    await release(accountId, work.meetingId, work.claim);
    return { again: false };
  }
  switch (work.plan.kind) {
    case 'create': return { again: await doCreate(accountId, work, meta) };
    case 'reconcile': {
      const adopted = await doReconcile(accountId, work, meta);
      return { again: adopted, adopted };
    }
    case 'patch': return { again: await doPatch(accountId, work) };
    case 'delete': return { again: await doDelete(accountId, work, work.plan.rehost) };
  }
}

/**
 * appointments.meeting_sync: converge the appointment's Zoom meeting on its
 * current state. A job for an older version is a no-op (a later job
 * converges). Throws MeetingSyncRetry for the job to back off and run again.
 */
export async function handleMeetingSyncJob(accountId: string, payload: MeetingSyncPayload, meta: MeetingJobMeta): Promise<void> {
  if (!zoomConfig()) return;
  // Two passes at most: the second re-reads the target after a successful write.
  for (let pass = 0; pass < 2; pass++) {
    const result = await runPass(accountId, payload.appointmentId, pass === 0 ? payload.version : null, meta);
    if (!result.again) return;
  }
}

/** Looks an ambiguous meeting up by its meeting_ref (never re-creates). */
export async function reconcileMeeting(accountId: string, appointmentMeetingId: string): Promise<'adopted' | 'unknown' | 'skipped'> {
  if (!zoomConfig()) return 'skipped';
  const [row] = await asWorker(accountId, (tx) => tx.$queryRaw<{ appointment_id: string }[]>`SELECT appointment_id::text AS appointment_id
    FROM appointment_meetings WHERE account_id=${accountId}::uuid AND id=${appointmentMeetingId}::uuid`);
  if (!row) return 'skipped';
  try {
    // Not the last attempt: an unmatched reconcile stays unknown without opening the task.
    const result = await runPass(accountId, row.appointment_id, null, { attempts: 0, maxAttempts: 1 }, 'reconcile');
    if (result.adopted) return 'adopted';
  } catch (error) {
    if (error instanceof MeetingSyncRetry) return 'unknown';
    throw error;
  }
  const [after] = await asWorker(accountId, (tx) => tx.$queryRaw<{ sync_state: string }[]>`SELECT sync_state FROM appointment_meetings
    WHERE account_id=${accountId}::uuid AND id=${appointmentMeetingId}::uuid`);
  return after?.sync_state === 'unknown' ? 'unknown' : 'skipped';
}

// ---------------------------------------------------------------------------
// Staff actions (route checked appointments.manage; the writes run as worker services)

async function staffTx<T>(ctx: MeetingActor, appointmentId: string,
  work: (tx: TenantTransaction, m: MeetingRow, appt: { status: string; version: number; start_at: Date }) => Promise<T>): Promise<T> {
  return asWorker(ctx.accountId, async (tx) => {
    const [appt] = await tx.$queryRaw<{ status: string; version: number; start_at: Date }[]>`SELECT status, version, start_at
      FROM appointments WHERE account_id=${ctx.accountId}::uuid AND id=${appointmentId}::uuid FOR UPDATE`;
    if (!appt) throw new MeetingError('not_found');
    const [m] = await tx.$queryRawUnsafe<MeetingRow[]>(
      `SELECT id::text AS id, connection_id::text AS connection_id, meeting_ref, host_zoom_user, external_meeting_id, join_url,
         supplied_url, sync_state, claim_token::text AS claim_token, claimed_until, synced_version, synced_start_at,
         synced_duration_min, last_error_code
       FROM appointment_meetings WHERE account_id=$1::uuid AND appointment_id=$2::uuid FOR UPDATE`, ctx.accountId, appointmentId);
    if (!m) throw new MeetingError('not_found');
    if (m.claimed_until && m.claimed_until.getTime() > Date.now()) throw new MeetingError('conflict');
    if (!['failed', 'unknown', 'creating'].includes(m.sync_state)) throw new MeetingError('conflict');
    return work(tx, m, appt);
  });
}

/** Staff "Create again" (appointments.manage): failed, audit, new ref, re-queue. */
export async function recreateMeeting(ctx: MeetingActor, appointmentId: string): Promise<void> {
  if (!zoomConfig()) throw new MeetingError('not_configured');
  await staffTx(ctx, appointmentId, async (tx, m, appt) => {
    if (appt.status !== 'confirmed' || appt.start_at.getTime() <= Date.now()) throw new MeetingError('conflict');
    const [conn] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM meeting_connections
      WHERE account_id=${ctx.accountId}::uuid AND status='active' LIMIT 1`;
    if (!conn) throw new MeetingError('not_connected');
    if (conn.id !== m.connection_id) throw new MeetingError('conflict');
    const ref = newMeetingRef();
    // Staff accept that an `unknown` meeting may exist in Zoom: a new reference means a new meeting.
    await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='creating', meeting_ref=${ref}, external_meeting_id=NULL,
        join_url=NULL, registrant_id=NULL, synced_version=NULL, synced_start_at=NULL, synced_duration_min=NULL,
        last_error_code='not_sent', claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${m.id}::uuid`;
    await auditTx(tx, ctx.accountId, ctx.userId, 'appointments.meeting_recreate', appointmentId, { previousState: m.sync_state });
    await insertSyncJob(tx, ctx.accountId, appointmentId, appt.version, `${appointmentKeys.meetingSync(appointmentId, appt.version)}:re:${ref}`);
  });
}

/** Staff "Use supplied link" (appointments.manage): manual, restores the supplied link. */
export async function useSuppliedLink(ctx: MeetingActor, appointmentId: string): Promise<void> {
  await staffTx(ctx, appointmentId, async (tx, m) => {
    await tx.$executeRaw`UPDATE appointment_meetings SET sync_state='manual', claim_token=NULL, claimed_until=NULL, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${m.id}::uuid`;
    await tx.$executeRaw`UPDATE appointments SET meeting_url=${m.supplied_url}, updated_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${appointmentId}::uuid`;
    await auditTx(tx, ctx.accountId, ctx.userId, 'appointments.meeting_use_link', appointmentId, { previousState: m.sync_state });
  });
}

/**
 * Sweep helper (T4 sweep.ts): re-queues one coalesced sync job per meeting that
 * is ambiguous (`unknown`, or `creating` with no live claim; recent, or for an
 * appointment still ahead, however long the connection was token_invalid) or
 * behind its appointment's version, and backfills confirmed future online
 * appointments that never got a meeting row (counted as requeued). The job
 * does the Zoom work; nothing here calls Zoom.
 */
export async function sweepMeetings(accountId: string): Promise<{ reconciled: number; requeued: number }> {
  if (!zoomConfig()) return { reconciled: 0, requeued: 0 };
  return asWorker(accountId, async (tx) => {
    const rows = await tx.$queryRaw<{ appointment_id: string; version: number; ambiguous: boolean }[]>`
      SELECT m.appointment_id::text AS appointment_id, a.version, (m.sync_state <> 'active') AS ambiguous
      FROM appointment_meetings m
      JOIN appointments a ON a.account_id=m.account_id AND a.id=m.appointment_id
      JOIN meeting_connections c ON c.account_id=m.account_id AND c.id=m.connection_id AND c.status='active'
      WHERE m.account_id=${accountId}::uuid AND COALESCE(m.claimed_until, '-infinity'::timestamptz) < now()
        AND ((m.sync_state IN ('creating','unknown') AND (m.updated_at > now() - interval '7 days' OR a.start_at > now()))
          OR (m.sync_state='active' AND COALESCE(m.synced_version, 0) < a.version))
      ORDER BY random() LIMIT ${SWEEP_BATCH}`;
    let reconciled = 0, requeued = 0;
    for (const r of rows) {
      await insertSyncJob(tx, accountId, r.appointment_id, r.version, `appt-mtg:${r.appointment_id}:sweep`, true);
      if (r.ambiguous) reconciled++; else requeued++;
    }
    requeued += await backfillMeetingSyncTx(tx, accountId);
    return { reconciled, requeued };
  });
}
