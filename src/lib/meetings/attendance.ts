// Zoom attendance evidence (Phase 9, design D8). Owner: T3.
//
// Evidence only: never sets an appointment status (markOutcome stays a staff
// action). A verified, minimised Zoom event (webhook route) becomes one
// append-only meeting_participant_events row; attendance_evidence only ever
// rises (none < guest_joined < registrant_joined); attended_seconds is
// recomputed from every stored join/leave pair. Events from well before the
// appointment (a host's test session in the same scheduled meeting) are
// ignored; the latest meeting.ended is the session end, and the first one at
// or after the start opens one "Record the outcome" task. app_deauthorized
// disconnects the workspace unless the connection was re-authorized after it
// (connection.ts deauthorizeZoom). Nothing here calls Zoom.
import { createHash } from 'node:crypto';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { openSystemTask } from '@/lib/appointments/tasks';
import { zoomConfig } from './config';
import { deauthorizeZoom } from './connection';
import {
  ATTENDANCE_EVIDENCE, type AttendanceEvidence, type ParticipantEventKind, type ParticipantKind,
} from './types';
import { isZoomEvent, parseMinimalZoomEvent, type MinimalZoomEvent, type ZoomEventName } from './webhook';

const KIND: Record<Exclude<ZoomEventName, 'app_deauthorized'>, ParticipantEventKind> = {
  'meeting.started': 'meeting_started',
  'meeting.ended': 'meeting_ended',
  'meeting.participant_joined': 'participant_joined',
  'meeting.participant_left': 'participant_left',
};
/** Evidence rows read back per meeting when recomputing attendance (a meeting has far fewer). */
const MAX_EVIDENCE_ROWS = 2000;
/** Events earlier than this before the appointment's start are another session of the same meeting id. */
export const EARLY_EVENT_MARGIN_MS = 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an event at `at` belongs to the appointment session starting at `startAt`. */
export const inSessionWindow = (at: Date, startAt: Date) => at.getTime() >= startAt.getTime() - EARLY_EVENT_MARGIN_MS;

/** The stronger of two evidence levels (evidence never goes down). */
export function strongerEvidence(a: AttendanceEvidence, b: AttendanceEvidence): AttendanceEvidence {
  return ATTENDANCE_EVIDENCE.indexOf(b) > ATTENDANCE_EVIDENCE.indexOf(a) ? b : a;
}

/**
 * Who the participant is, from ids only: the host when their Zoom user id is the
 * meeting's host_id; our registrant when the registrant id matches the one we
 * created; anyone else is a guest (never assumed to be the customer).
 */
export function participantKind(
  event: Pick<MinimalZoomEvent, 'hostId' | 'participantUserId' | 'registrantId'>, ourRegistrantId: string | null,
): ParticipantKind {
  if (event.hostId && event.participantUserId && event.participantUserId === event.hostId) return 'host';
  if (ourRegistrantId && event.registrantId && event.registrantId === ourRegistrantId) return 'registrant';
  return 'guest';
}

export interface EvidenceRow {
  kind: ParticipantEventKind;
  participant_kind: ParticipantKind | null;
  participant_key: string | null;
  event_at: Date;
}

/**
 * Seconds during which at least one non-host participant (only our registrant
 * once one joined) was in the meeting: per participant, join opens and leave
 * closes an interval; an interval still open is closed at meeting end, or not
 * counted while the meeting runs. Overlaps between participants count once.
 * Pure and order-independent (rows are sorted here).
 */
export function attendedSeconds(rows: EvidenceRow[], endedAt: Date | null): number {
  const people = rows.filter((r) => r.participant_key && r.participant_kind && r.participant_kind !== 'host'
    && (r.kind === 'participant_joined' || r.kind === 'participant_left'));
  const registrantOnly = people.some((r) => r.participant_kind === 'registrant' && r.kind === 'participant_joined');
  const counted = registrantOnly ? people.filter((r) => r.participant_kind === 'registrant') : people;
  const byKey = new Map<string, EvidenceRow[]>();
  for (const r of counted) byKey.set(r.participant_key as string, [...(byKey.get(r.participant_key as string) ?? []), r]);
  const intervals: [number, number][] = [];
  for (const list of byKey.values()) {
    list.sort((x, y) => x.event_at.getTime() - y.event_at.getTime() || (x.kind === 'participant_joined' ? -1 : 1));
    let open: number | null = null;
    for (const r of list) {
      const at = r.event_at.getTime();
      if (r.kind === 'participant_joined') { if (open === null) open = at; }
      else if (open !== null) { if (at > open) intervals.push([open, at]); open = null; }
    }
    if (open !== null && endedAt && endedAt.getTime() > open) intervals.push([open, endedAt.getTime()]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of intervals) {
    if (current && start <= current[1]) current[1] = Math.max(current[1], end);
    else { if (current) total += current[1] - current[0]; current = [start, end]; }
  }
  if (current) total += current[1] - current[0];
  return Math.floor(total / 1000);
}

/** When the event happened: the participant's join or leave time, else Zoom's event time. */
function eventAt(event: MinimalZoomEvent, kind: ParticipantEventKind, now: Date): Date {
  const iso = kind === 'participant_joined' ? event.joinTime : kind === 'participant_left' ? event.leaveTime : null;
  if (iso) return new Date(iso);
  return event.eventTs ? new Date(event.eventTs) : now;
}

interface MeetingRow {
  id: string;
  appointment_id: string;
  registrant_id: string | null;
  attendance_evidence: AttendanceEvidence;
  meeting_ended_at: Date | null;
}

async function deauthorize(accountId: string, event: MinimalZoomEvent, connectionId: string | null): Promise<void> {
  if (!event.zoomAccountId) return;
  // Only the live connection of that Zoom account, and only when it was not re-authorized after the event.
  await deauthorizeZoom(accountId, {
    zoomAccountId: event.zoomAccountId, connectionId, eventAt: event.eventTs ? new Date(event.eventTs) : null,
  });
}

async function recordEvidence(tx: TenantTransaction, accountId: string, event: MinimalZoomEvent, kind: ParticipantEventKind, now: Date) {
  // The meeting must be this workspace's and belong to a connection of the Zoom account that sent the event.
  const [found] = await tx.$queryRaw<{ id: string; appointment_id: string }[]>`
    SELECT m.id, m.appointment_id FROM appointment_meetings m
      JOIN meeting_connections c ON c.account_id=m.account_id AND c.id=m.connection_id
    WHERE m.account_id=${accountId}::uuid AND m.external_meeting_id=${event.meetingId} AND c.zoom_account_id=${event.zoomAccountId}
    ORDER BY m.created_at DESC LIMIT 1`;
  if (!found) return;
  // Lock order (design D16): appointment, then its meeting.
  const [appointment] = await tx.$queryRaw<{ status: string; version: number; start_at: Date }[]>`
    SELECT status, version, start_at FROM appointments WHERE account_id=${accountId}::uuid AND id=${found.appointment_id}::uuid FOR UPDATE`;
  const [meeting] = await tx.$queryRaw<MeetingRow[]>`
    SELECT id, appointment_id, registrant_id, attendance_evidence, meeting_ended_at FROM appointment_meetings
    WHERE account_id=${accountId}::uuid AND id=${found.id}::uuid FOR UPDATE`;
  if (!appointment || !meeting) return;

  const at = eventAt(event, kind, now);
  // A session well before the appointment (for example the host testing audio the day before) is not its evidence.
  if (!inSessionWindow(at, appointment.start_at)) return;
  const who = kind === 'participant_joined' || kind === 'participant_left' ? participantKind(event, meeting.registrant_id) : null;
  const key = who ? event.participantKey : null;
  const receipt = `zoom:${createHash('sha256').update([meeting.id, kind, key ?? '', at.toISOString()].join('|')).digest('hex')}`;
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO meeting_participant_events(appointment_meeting_id,kind,participant_kind,participant_key,event_at,receipt_key)
    VALUES(${meeting.id}::uuid,${kind},${who},${key},${at},${receipt}) ON CONFLICT (receipt_key) DO NOTHING RETURNING id`;
  // The same join, leave, start or end seen again (a redelivery with a new body) changes nothing.
  if (!inserted.length) return;

  let evidence = meeting.attendance_evidence;
  let firstJoin: Date | null = null;
  if (kind === 'participant_joined' && (who === 'guest' || who === 'registrant')) {
    evidence = strongerEvidence(evidence, who === 'registrant' ? 'registrant_joined' : 'guest_joined');
    firstJoin = at;
    if (meeting.attendance_evidence === 'none')
      await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor,detail)
        VALUES(${meeting.appointment_id}::uuid,${appointment.version},'meeting_joined_provider','system',${who})`;
  }
  // The latest end wins: an early session's end inside the margin is replaced by the real one.
  const endedAt = kind === 'meeting_ended' && (!meeting.meeting_ended_at || at > meeting.meeting_ended_at) ? at : meeting.meeting_ended_at;
  const rows = await tx.$queryRaw<EvidenceRow[]>`SELECT kind, participant_kind, participant_key, event_at FROM meeting_participant_events
    WHERE account_id=${accountId}::uuid AND appointment_meeting_id=${meeting.id}::uuid ORDER BY event_at LIMIT ${MAX_EVIDENCE_ROWS}`;
  await tx.$executeRaw`UPDATE appointment_meetings SET attendance_evidence=${evidence},
      first_join_at=LEAST(first_join_at, ${firstJoin}::timestamptz), attended_seconds=${attendedSeconds(rows, endedAt)},
      meeting_ended_at=${endedAt}::timestamptz, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${meeting.id}::uuid`;
  // The first end at or after the start opens one "Record the outcome" task while the outcome is still open.
  const start = appointment.start_at.getTime();
  if (kind === 'meeting_ended' && at.getTime() >= start && !(meeting.meeting_ended_at && meeting.meeting_ended_at.getTime() >= start)
    && appointment.status === 'confirmed')
    await openSystemTask(tx, accountId, { kind: 'meeting_outcome', appointmentId: meeting.appointment_id, dueAt: now });
}

/** meetings.zoom_event job: one minimised, verified Zoom event for this workspace. */
export async function handleZoomEventJob(accountId: string, payload: Record<string, unknown>): Promise<void> {
  const event = parseMinimalZoomEvent(payload);
  // A malformed or unsubscribed event, or a deployment whose Zoom config is gone: nothing to do, no retry.
  if (!event || !isZoomEvent(event.event) || !zoomConfig()) return;
  if (event.event === 'app_deauthorized') {
    // The connection the delivery was routed to (webhook route); a later connection is not the one deauthorized.
    const connectionId = typeof payload.connectionId === 'string' && UUID.test(payload.connectionId) ? payload.connectionId : null;
    return deauthorize(accountId, event, connectionId);
  }
  if (!event.meetingId || !event.zoomAccountId) return;
  const kind = KIND[event.event];
  const now = new Date();
  await withTenant({ accountId, role: 'owner' }, (tx) => recordEvidence(tx, accountId, event, kind, now), getWorkerPrisma());
}
