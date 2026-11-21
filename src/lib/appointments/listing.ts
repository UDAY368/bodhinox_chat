/**
 * Staff reads: the schedule list and one appointment with its history,
 * customer-message outcomes and tasks. Returns the contact's id and name only
 * (no phone, no intake, no hold code) so masking rules elsewhere are not
 * bypassed through this view.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AppointmentMeetingView } from '@/lib/meetings/types';
import { APPOINTMENT_COLUMNS, getAppointment } from './booking';
import { isUuid } from './config';
import { listTasks, type TaskRow } from './tasks';
import {
  APPOINTMENT_STATUSES, AppointmentError,
  type AppointmentEventKind, type AppointmentMessageKind, type AppointmentMessageStatus, type AppointmentRow, type AppointmentStatus,
} from './types';

export const MAX_LIST_RANGE_DAYS = 62;
/** The most rows one schedule request returns (the week and day views). */
export const MAX_LIST_ROWS = 500;

export interface ScheduleFilter {
  from: Date;
  to: Date;
  status?: AppointmentStatus | null;
  staffId?: string | null;
  locationId?: string | null;
  serviceId?: string | null;
  /** Confirmed appointments that already ended and still need an outcome. */
  needsOutcome?: boolean;
  /** Rows per page (1..MAX_LIST_ROWS); MAX_LIST_ROWS when unset. */
  limit?: number;
  /** Continue after this row (a previous page's nextCursor, decoded). */
  cursor?: ScheduleCursor | null;
}

/** A position in (start_at, id) order. */
export interface ScheduleCursor { startAt: Date; id: string }

export type ScheduleRow = AppointmentRow & { contact_name: string | null; conversation_id: string | null };

export interface SchedulePage {
  rows: ScheduleRow[];
  /** Opaque; pass back as ?cursor= for the next page. null on the last page. */
  nextCursor: string | null;
  /** More rows match than this page holds. */
  truncated: boolean;
}

/** "<start ISO>_<id>" in base64url (pure; tested). */
export function encodeCursor(c: ScheduleCursor): string {
  return Buffer.from(`${c.startAt.toISOString()}_${c.id}`, 'utf8').toString('base64url');
}

/** The cursor, or null when it is not one encodeCursor wrote (pure; tested). */
export function decodeCursor(value: string | null | undefined): ScheduleCursor | null {
  if (!value || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const at = text.lastIndexOf('_');
  if (at < 0) return null;
  const startAt = new Date(text.slice(0, at));
  const id = text.slice(at + 1);
  if (Number.isNaN(startAt.getTime()) || !isUuid(id)) return null;
  return { startAt, id };
}

export function parseScheduleFilter(params: URLSearchParams): ScheduleFilter {
  const from = new Date(params.get('from') ?? '');
  const to = new Date(params.get('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from
    || to.getTime() - from.getTime() > MAX_LIST_RANGE_DAYS * 86_400_000) throw new AppointmentError('invalid');
  const id = (k: string) => {
    const v = params.get(k);
    if (!v) return null;
    if (!isUuid(v)) throw new AppointmentError('invalid');
    return v;
  };
  const status = params.get('status');
  if (status && !(APPOINTMENT_STATUSES as readonly string[]).includes(status)) throw new AppointmentError('invalid');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? MAX_LIST_ROWS : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_ROWS) throw new AppointmentError('invalid');
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) throw new AppointmentError('invalid');
  return {
    from, to, status: (status as AppointmentStatus) || null, staffId: id('staff_id'), locationId: id('location_id'),
    serviceId: id('service_id'), needsOutcome: params.get('needs_outcome') === '1', limit, cursor,
  };
}

// The contact's name and, when the booking does not record its own chat, the contact's latest
// conversation: one bounded lateral lookup each, by primary or indexed keys.
const CONTACT_JOIN = `LEFT JOIN LATERAL (SELECT c.name FROM contacts c WHERE c.account_id=a.account_id AND c.id=a.contact_id) ct ON true
  LEFT JOIN LATERAL (SELECT v.id FROM conversations v WHERE a.conversation_id IS NULL AND a.contact_id IS NOT NULL
    AND v.account_id=a.account_id AND v.contact_id=a.contact_id ORDER BY v.last_message_at DESC NULLS LAST LIMIT 1) cv ON true`;
const CONTACT_COLUMNS = 'ct.name AS contact_name, COALESCE(a.conversation_id, cv.id) AS conversation_id';
const PREFIXED = APPOINTMENT_COLUMNS.split(',').map((c) => c.trim()).filter((c) => c !== 'conversation_id').map((c) => `a.${c}`).join(', ');

/**
 * One page of the schedule in (start_at, id) order, read with the
 * (account_id, start_at, id) index. Reads limit + 1 rows to know whether the
 * list was cut.
 */
export async function listSchedule(tx: TenantTransaction, accountId: string, f: ScheduleFilter, now = new Date()): Promise<SchedulePage> {
  const limit = Math.min(Math.max(1, f.limit ?? MAX_LIST_ROWS), MAX_LIST_ROWS);
  const rows = await tx.$queryRawUnsafe<ScheduleRow[]>(`SELECT ${PREFIXED}, ${CONTACT_COLUMNS}
    FROM appointments a ${CONTACT_JOIN}
    WHERE a.account_id=$1::uuid AND a.start_at < $3 AND a.end_at > $2
      AND ($4::text IS NULL OR a.status=$4) AND ($5::uuid IS NULL OR a.staff_id=$5::uuid)
      AND ($6::uuid IS NULL OR a.location_id=$6::uuid) AND ($7::uuid IS NULL OR a.service_id=$7::uuid)
      AND (NOT $8 OR (a.status='confirmed' AND a.end_at < $9))
      AND ($10::timestamptz IS NULL OR (a.start_at, a.id) > ($10::timestamptz, $11::uuid))
    ORDER BY a.start_at, a.id LIMIT ${limit + 1}`,
    accountId, f.from, f.to, f.status ?? null, f.staffId ?? null, f.locationId ?? null, f.serviceId ?? null, !!f.needsOutcome, now,
    f.cursor?.startAt ?? null, f.cursor?.id ?? null);
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { rows: page, truncated, nextCursor: truncated && last ? encodeCursor({ startAt: last.start_at, id: last.id }) : null };
}

export interface EventRow {
  id: string; version: number; kind: AppointmentEventKind; old_start_at: Date | null; new_start_at: Date | null;
  actor: string; actor_user_id: string | null; detail: string | null; created_at: Date;
}
export interface MessageRow {
  id: string; version: number; kind: AppointmentMessageKind; status: AppointmentMessageStatus; reason: string | null;
  resolved_at: Date | null; resolved_by: string | null; created_at: Date; updated_at: Date;
}

export interface AppointmentDetail {
  appointment: ScheduleRow;
  events: EventRow[];
  messages: MessageRow[];
  tasks: TaskRow[];
  /** The Zoom meeting (Phase 9), or null; agents and above only (RLS), never the registrant id or claim token. */
  meeting: AppointmentMeetingView | null;
  links: AppointmentLinks;
}

type MeetingDbRow = Omit<AppointmentMeetingView, 'first_join_at' | 'meeting_ended_at'> & { first_join_at: Date | null; meeting_ended_at: Date | null };

/** The meeting view for the sheet (granted columns only). */
export async function getAppointmentMeeting(tx: TenantTransaction, accountId: string, appointmentId: string): Promise<AppointmentMeetingView | null> {
  const [row] = await tx.$queryRaw<MeetingDbRow[]>`SELECT sync_state, join_url, supplied_url, last_error_code, attendance_evidence,
      first_join_at, attended_seconds, meeting_ended_at
    FROM appointment_meetings WHERE account_id=${accountId}::uuid AND appointment_id=${appointmentId}::uuid`;
  if (!row) return null;
  return {
    ...row,
    first_join_at: row.first_join_at ? row.first_join_at.toISOString() : null,
    meeting_ended_at: row.meeting_ended_at ? row.meeting_ended_at.toISOString() : null,
  };
}

export async function getAppointmentDetail(tx: TenantTransaction, accountId: string, id: string): Promise<AppointmentDetail> {
  if (!isUuid(id) || !(await getAppointment(tx, accountId, id))) throw new AppointmentError('not_found');
  const [appointment] = await tx.$queryRawUnsafe<ScheduleRow[]>(`SELECT ${PREFIXED}, ${CONTACT_COLUMNS}
    FROM appointments a ${CONTACT_JOIN} WHERE a.account_id=$1::uuid AND a.id=$2::uuid`, accountId, id);
  const events = await tx.$queryRaw<EventRow[]>`SELECT id, version, kind, old_start_at, new_start_at, actor, actor_user_id, detail, created_at
    FROM appointment_events WHERE account_id=${accountId}::uuid AND appointment_id=${id}::uuid ORDER BY created_at, id`;
  const messages = await tx.$queryRaw<MessageRow[]>`SELECT id, version, kind, status, reason, resolved_at, resolved_by, created_at, updated_at
    FROM appointment_messages WHERE account_id=${accountId}::uuid AND appointment_id=${id}::uuid ORDER BY created_at, id`;
  const tasks = await listTasks(tx, accountId, { appointmentId: id });
  const meeting = await getAppointmentMeeting(tx, accountId, id);
  const links = await getAppointmentLinks(tx, accountId, appointment);
  return { appointment, events, messages, tasks, meeting, links };
}

/** The deal, campaign and ad a booking is linked to (names and ids only; no ad body or click id). */
export interface AppointmentLinks {
  deal: { id: string; title: string; status: string | null; stage_name: string | null } | null;
  broadcast: { id: string; name: string } | null;
  ad: { id: string; headline: string | null; source_type: string } | null;
}

export async function getAppointmentLinks(
  tx: TenantTransaction, accountId: string, a: Pick<AppointmentRow, 'deal_id' | 'broadcast_id' | 'ad_referral_id'>,
): Promise<AppointmentLinks> {
  const [deal] = a.deal_id ? await tx.$queryRaw<AppointmentLinks['deal'][]>`SELECT d.id, d.title, d.status, s.name AS stage_name
    FROM deals d LEFT JOIN pipeline_stages s ON s.account_id=d.account_id AND s.id=d.stage_id
    WHERE d.account_id=${accountId}::uuid AND d.id=${a.deal_id}::uuid` : [];
  const [broadcast] = a.broadcast_id ? await tx.$queryRaw<AppointmentLinks['broadcast'][]>`SELECT id, name FROM broadcasts
    WHERE account_id=${accountId}::uuid AND id=${a.broadcast_id}::uuid` : [];
  const [ad] = a.ad_referral_id ? await tx.$queryRaw<AppointmentLinks['ad'][]>`SELECT id, headline, source_type FROM ad_referrals
    WHERE account_id=${accountId}::uuid AND id=${a.ad_referral_id}::uuid` : [];
  return { deal: deal ?? null, broadcast: broadcast ?? null, ad: ad ?? null };
}

/** Admin: mark a blocked, failed or uncertain customer message as reconciled. Never re-sends. */
export async function resolveMessage(tx: TenantTransaction, accountId: string, userId: string, messageId: string): Promise<MessageRow> {
  if (!isUuid(messageId)) throw new AppointmentError('not_found');
  const [row] = await tx.$queryRaw<MessageRow[]>`UPDATE appointment_messages SET resolved_at=now(), resolved_by=${userId}::uuid
    WHERE account_id=${accountId}::uuid AND id=${messageId}::uuid AND resolved_at IS NULL
      AND status IN ('blocked','failed','outcome_unknown')
    RETURNING id, version, kind, status, reason, resolved_at, resolved_by, created_at, updated_at`;
  if (!row) throw new AppointmentError('not_found');
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,'appointments.message.resolved',${messageId},${JSON.stringify({ status: row.status })}::jsonb)`;
  return row;
}
