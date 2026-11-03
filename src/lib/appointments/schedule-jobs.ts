/**
 * Durable appointment jobs, inserted in the caller's transaction (design
 * sections 4 and 6). A booking change that triggers a customer message
 * commits its job atomically with the change; nothing is sent before commit,
 * and a failed send never rolls back the booking.
 *
 * Raw INSERT ... ON CONFLICT (dedupe_key) DO NOTHING, as commerce event rules
 * do: the app role may insert jobs for its own tenant, and every key comes
 * from keys.ts so a retried transaction never queues a duplicate.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { appointmentKeys } from './keys';
import {
  APPOINTMENT_JOB_TYPES,
  type AppointmentEventKind, type AppointmentJobType, type EventJobPayload, type FollowupJobPayload,
  type HoldExpireJobPayload, type NoticeKind, type NotifyJobPayload, type ReminderJobPayload, type ReminderKind,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The hold-expiry job runs this long after hold_expires_at, so a late code can still win. */
export const HOLD_EXPIRY_GRACE_MS = 5 * MINUTE;
/** A 24h reminder is only worth sending when the 2h one is not about to follow. */
const MIN_LEAD_FOR_24H_MS = 2 * HOUR + 15 * MINUTE;

export async function insertJob(
  tx: TenantTransaction,
  accountId: string,
  type: AppointmentJobType,
  payload: object,
  dedupeKey: string,
  runAt: Date = new Date(),
): Promise<boolean> {
  const inserted = await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${type},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},${runAt})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return inserted > 0;
}

/** Staff notification, automation trigger, webhook and superseded-reminder retirement (run by the worker after commit). */
export function enqueueEvent(tx: TenantTransaction, accountId: string, appointmentId: string, version: number, kind: AppointmentEventKind) {
  const payload: EventJobPayload = { appointmentId, version, kind };
  return insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.event, payload, appointmentKeys.event(appointmentId, version, kind));
}

/**
 * NotifyJobPayload plus the start the notice announces (ISO). A later
 * practitioner-only reassignment bumps the version without changing the time,
 * so the dispatcher can tell "the time this notice states still holds" from
 * "the version moved on" (startAt is absent on jobs queued before this field).
 */
export type TimedNotifyJobPayload = NotifyJobPayload;

/** A customer notice (confirmation, rescheduled or cancelled) for this version. */
export function enqueueNotice(
  tx: TenantTransaction, accountId: string, appointmentId: string, version: number, kind: Exclude<NoticeKind, 'hold_reply'>,
  startAt?: Date,
) {
  const payload: TimedNotifyJobPayload = { appointmentId, version, kind, ...(startAt ? { startAt: startAt.toISOString() } : {}) };
  return insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.notify, payload, appointmentKeys.notify(appointmentId, version, kind));
}

export function enqueueHoldExpiry(tx: TenantTransaction, accountId: string, appointmentId: string, version: number, holdExpiresAt: Date) {
  const payload: HoldExpireJobPayload = { appointmentId, version };
  return insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.holdExpire, payload, appointmentKeys.holdExpire(appointmentId, version),
    new Date(holdExpiresAt.getTime() + HOLD_EXPIRY_GRACE_MS));
}

export function enqueueFollowup(
  tx: TenantTransaction, accountId: string, appointmentId: string, version: number, kind: FollowupJobPayload['kind'], runAt: Date,
) {
  const payload: FollowupJobPayload = { appointmentId, version, kind };
  const key = kind === 'feedback' ? appointmentKeys.feedback(appointmentId, version) : appointmentKeys.rebook(appointmentId, version);
  return insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.followup, payload, key, runAt);
}

export interface ReminderPlanEntry {
  kind: ReminderKind;
  runAt: Date;
  /** null = queue it; otherwise the reminder_skipped detail code. */
  skipped: 'past_due_24h' | 'past_due_2h' | null;
}

/**
 * Which reminders a confirmed appointment gets (pure). Absolute times, so DST
 * never shifts them; a time already past is skipped, never sent at once.
 */
export function planReminders(startAt: Date, now: Date): ReminderPlanEntry[] {
  const start = startAt.getTime();
  const runAt24 = new Date(start - 24 * HOUR);
  const runAt2 = new Date(start - 2 * HOUR);
  const lead = start - now.getTime();
  return [
    { kind: '24h', runAt: runAt24, skipped: runAt24.getTime() > now.getTime() && lead > MIN_LEAD_FOR_24H_MS ? null : 'past_due_24h' },
    { kind: '2h', runAt: runAt2, skipped: runAt2.getTime() > now.getTime() ? null : 'past_due_2h' },
  ];
}

/**
 * Queue this version's reminders, or record why each was skipped. Called on
 * every version bump of a confirmed future appointment (confirm, reschedule,
 * reassignment). The settings toggles are read at dispatch, not here.
 */
export async function scheduleReminders(
  tx: TenantTransaction,
  accountId: string,
  appointment: { id: string; version: number; start_at: Date },
  now: Date = new Date(),
): Promise<ReminderPlanEntry[]> {
  const plan = planReminders(appointment.start_at, now);
  for (const entry of plan) {
    if (entry.skipped) {
      await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor,detail)
        VALUES(${appointment.id}::uuid,${appointment.version},'reminder_skipped','system',${entry.skipped})`;
      continue;
    }
    const payload: ReminderJobPayload = { appointmentId: appointment.id, version: appointment.version, kind: entry.kind };
    await insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.reminder, payload,
      appointmentKeys.reminder(appointment.id, appointment.version, entry.kind), entry.runAt);
  }
  return plan;
}
