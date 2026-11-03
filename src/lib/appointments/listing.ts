/**
 * Staff reads: the schedule list and one appointment with its history,
 * customer-message outcomes and tasks. Returns the contact's id and name only
 * (no phone, no intake, no hold code) so masking rules elsewhere are not
 * bypassed through this view.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { APPOINTMENT_COLUMNS, getAppointment } from './booking';
import { isUuid } from './config';
import { listTasks, type TaskRow } from './tasks';
import {
  APPOINTMENT_STATUSES, AppointmentError,
  type AppointmentEventKind, type AppointmentMessageKind, type AppointmentMessageStatus, type AppointmentRow, type AppointmentStatus,
} from './types';

export const MAX_LIST_RANGE_DAYS = 62;
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
}

export type ScheduleRow = AppointmentRow & { contact_name: string | null; conversation_id: string | null };

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
  return {
    from, to, status: (status as AppointmentStatus) || null, staffId: id('staff_id'), locationId: id('location_id'),
    serviceId: id('service_id'), needsOutcome: params.get('needs_outcome') === '1',
  };
}

const CONTACT_JOIN = `(SELECT c.name FROM contacts c WHERE c.account_id=a.account_id AND c.id=a.contact_id) AS contact_name,
  (SELECT v.id FROM conversations v WHERE v.account_id=a.account_id AND v.contact_id=a.contact_id
    ORDER BY v.last_message_at DESC NULLS LAST LIMIT 1) AS conversation_id`;
const PREFIXED = APPOINTMENT_COLUMNS.split(',').map((c) => `a.${c.trim()}`).join(', ');

export async function listSchedule(tx: TenantTransaction, accountId: string, f: ScheduleFilter, now = new Date()): Promise<ScheduleRow[]> {
  return tx.$queryRawUnsafe<ScheduleRow[]>(`SELECT ${PREFIXED}, ${CONTACT_JOIN}
    FROM appointments a WHERE a.account_id=$1::uuid AND a.start_at < $3 AND a.end_at > $2
      AND ($4::text IS NULL OR a.status=$4) AND ($5::uuid IS NULL OR a.staff_id=$5::uuid)
      AND ($6::uuid IS NULL OR a.location_id=$6::uuid) AND ($7::uuid IS NULL OR a.service_id=$7::uuid)
      AND (NOT $8 OR (a.status='confirmed' AND a.end_at < $9))
    ORDER BY a.start_at, a.id LIMIT ${MAX_LIST_ROWS}`,
    accountId, f.from, f.to, f.status ?? null, f.staffId ?? null, f.locationId ?? null, f.serviceId ?? null, !!f.needsOutcome, now);
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
}

export async function getAppointmentDetail(tx: TenantTransaction, accountId: string, id: string): Promise<AppointmentDetail> {
  if (!isUuid(id) || !(await getAppointment(tx, accountId, id))) throw new AppointmentError('not_found');
  const [appointment] = await tx.$queryRawUnsafe<ScheduleRow[]>(`SELECT ${PREFIXED}, ${CONTACT_JOIN}
    FROM appointments a WHERE a.account_id=$1::uuid AND a.id=$2::uuid`, accountId, id);
  const events = await tx.$queryRaw<EventRow[]>`SELECT id, version, kind, old_start_at, new_start_at, actor, actor_user_id, detail, created_at
    FROM appointment_events WHERE account_id=${accountId}::uuid AND appointment_id=${id}::uuid ORDER BY created_at, id`;
  const messages = await tx.$queryRaw<MessageRow[]>`SELECT id, version, kind, status, reason, resolved_at, resolved_by, created_at, updated_at
    FROM appointment_messages WHERE account_id=${accountId}::uuid AND appointment_id=${id}::uuid ORDER BY created_at, id`;
  const tasks = await listTasks(tx, accountId, { appointmentId: id });
  return { appointment, events, messages, tasks };
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
