/**
 * Follow-up tasks (CRM-01 had none). Agents and above write them; the
 * worker and markOutcome create rebook and next-step tasks automatically.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { AppointmentFieldError, isUuid } from './config';
import {
  AppointmentError, SYSTEM_TASK_KINDS, TASK_KINDS, TASK_STATUSES, type SystemTaskKind, type TaskKind, type TaskStatus,
} from './types';

export interface TaskRow {
  id: string;
  contact_id: string | null;
  appointment_id: string | null;
  kind: TaskKind;
  title: string;
  due_at: Date | null;
  assigned_to: string | null;
  status: TaskStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, contact_id, appointment_id, kind, title, due_at, assigned_to, status, created_by, created_at, updated_at';
export const MAX_TASKS_PAGE = 200;

type Body = Record<string, unknown>;
function body(raw: unknown): Body {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppointmentError('invalid');
  return raw as Body;
}
function title(b: Body): string {
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 200) throw new AppointmentFieldError('title');
  return b.title.trim();
}
function dueAt(b: Body): Date | null {
  if (b.due_at === null) return null;
  const d = typeof b.due_at === 'string' ? new Date(b.due_at) : null;
  if (!d || Number.isNaN(d.getTime())) throw new AppointmentFieldError('due_at');
  return d;
}
function optId(b: Body, k: string): string | null {
  if (b[k] === null || b[k] === undefined || b[k] === '') return null;
  if (!isUuid(b[k])) throw new AppointmentFieldError(k);
  return b[k] as string;
}
function dbError(error: unknown, field: string): never {
  if (/foreign key|23503/i.test(error instanceof Error ? error.message : '')) throw new AppointmentFieldError(field);
  throw error;
}

export interface TaskFilter {
  status?: TaskStatus;
  appointmentId?: string;
  assignedTo?: string;
  limit?: number;
}

export async function listTasks(tx: TenantTransaction, accountId: string, filter: TaskFilter = {}): Promise<TaskRow[]> {
  const status = filter.status && (TASK_STATUSES as readonly string[]).includes(filter.status) ? filter.status : null;
  const appointment = filter.appointmentId && isUuid(filter.appointmentId) ? filter.appointmentId : null;
  const assignee = filter.assignedTo && isUuid(filter.assignedTo) ? filter.assignedTo : null;
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), MAX_TASKS_PAGE);
  return tx.$queryRawUnsafe<TaskRow[]>(`SELECT ${COLUMNS} FROM tasks WHERE account_id=$1::uuid
      AND ($2::text IS NULL OR status=$2) AND ($3::uuid IS NULL OR appointment_id=$3::uuid) AND ($4::uuid IS NULL OR assigned_to=$4::uuid)
    ORDER BY (status='open') DESC, due_at NULLS LAST, created_at DESC LIMIT ${limit}`, accountId, status, appointment, assignee);
}

export async function createTask(tx: TenantTransaction, accountId: string, userId: string | null, raw: unknown): Promise<TaskRow> {
  const b = body(raw);
  const kind = b.kind === undefined ? 'manual' : b.kind;
  if (!(TASK_KINDS as readonly unknown[]).includes(kind)) throw new AppointmentFieldError('kind');
  const appointmentId = optId(b, 'appointment_id');
  let contactId = optId(b, 'contact_id');
  // A task on an appointment follows that appointment's customer.
  if (appointmentId) {
    const [appt] = await tx.$queryRaw<{ contact_id: string | null }[]>`SELECT contact_id FROM appointments
      WHERE account_id=${accountId}::uuid AND id=${appointmentId}::uuid`;
    if (!appt) throw new AppointmentFieldError('appointment_id');
    contactId = appt.contact_id;
  }
  const [row] = await tx.$queryRawUnsafe<TaskRow[]>(`INSERT INTO tasks(contact_id,appointment_id,kind,title,due_at,assigned_to,created_by)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7::uuid) RETURNING ${COLUMNS}`,
    contactId, appointmentId, kind, title(b), b.due_at === undefined ? null : dueAt(b), optId(b, 'assigned_to'), userId)
    .catch((e) => dbError(e, 'assigned_to'));
  return row;
}

/**
 * Opens a worker-only task (Phase 9: meeting_sync, meeting_outcome) for an
 * appointment's customer, assigned to the practitioner's linked member while
 * that member is still in the workspace. At most one open task per
 * appointment and kind (partial unique tasks_open_meeting_key), so a repeated
 * call is a no-op. Returns whether a task was opened. Members never create
 * these kinds (createTask accepts TASK_KINDS only).
 */
export async function openSystemTask(
  tx: TenantTransaction, accountId: string, input: { kind: SystemTaskKind; appointmentId: string; dueAt?: Date | null },
): Promise<boolean> {
  if (!(SYSTEM_TASK_KINDS as readonly string[]).includes(input.kind) || !isUuid(input.appointmentId)) throw new AppointmentError('invalid');
  const inserted = await tx.$executeRaw`INSERT INTO tasks(contact_id,appointment_id,kind,title,due_at,assigned_to,created_by)
    SELECT a.contact_id, a.id, ${input.kind}, left(a.service_name, 200), ${input.dueAt ?? new Date()},
      (SELECT m.user_id FROM appointment_staff s JOIN account_memberships m ON m.account_id=s.account_id AND m.user_id=s.user_id
        WHERE s.account_id=a.account_id AND s.id=a.staff_id),
      NULL
    FROM appointments a WHERE a.account_id=${accountId}::uuid AND a.id=${input.appointmentId}::uuid
    ON CONFLICT DO NOTHING`;
  return inserted > 0;
}

export async function updateTask(tx: TenantTransaction, accountId: string, id: string, raw: unknown): Promise<TaskRow> {
  const b = body(raw);
  const [current] = await tx.$queryRawUnsafe<TaskRow[]>(`SELECT ${COLUMNS} FROM tasks WHERE account_id=$1::uuid AND id=$2::uuid FOR UPDATE`, accountId, id);
  if (!current) throw new AppointmentError('not_found');
  const status = b.status === undefined ? current.status : b.status;
  if (!(TASK_STATUSES as readonly unknown[]).includes(status)) throw new AppointmentFieldError('status');
  const [row] = await tx.$queryRawUnsafe<TaskRow[]>(`UPDATE tasks SET title=$3, due_at=$4, assigned_to=$5::uuid, status=$6, updated_at=now()
    WHERE account_id=$1::uuid AND id=$2::uuid RETURNING ${COLUMNS}`, accountId, id,
    b.title === undefined ? current.title : title(b),
    b.due_at === undefined ? current.due_at : dueAt(b),
    b.assigned_to === undefined ? current.assigned_to : optId(b, 'assigned_to'),
    status).catch((e) => dbError(e, 'assigned_to'));
  return row;
}
