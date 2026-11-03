/**
 * Worker entry point for appointment jobs (src/lib/jobs/handlers.ts).
 *
 * Validates each payload contract, then delegates:
 *  - appointments.reminder    -> reminders.ts
 *  - appointments.notify      -> notify-customer.ts (notices and the BOOK-code reply)
 *  - appointments.event       -> events.ts (retirement, staff alert, automations, webhook)
 *  - appointments.hold_expire -> booking.ts expireHold
 *  - appointments.followup    -> followup.ts
 * Every handler re-checks the appointment's version and status, so a
 * superseded or redelivered job is a no-op.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { expireHold } from './booking';
import { handleAppointmentEventJob } from './events';
import { handleAppointmentFollowupJob } from './followup';
import { handleAppointmentNoticeJob, handleHoldReplyJob } from './notify-customer';
import { handleAppointmentReminderJob } from './reminders';
import {
  APPOINTMENT_EVENT_KINDS, APPOINTMENT_JOB_TYPES, type AppointmentEventKind, type AppointmentJobType, type NotifyJobPayload,
} from './types';

export interface AppointmentJobMeta {
  attempts: number;
  maxAttempts: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTICES = ['confirmation', 'rescheduled', 'cancelled'] as const;
const HOLD_REASONS = ['code_unknown', 'slot_unavailable', 'hold_expired', 'customer_conflict'] as const;

function invalid(type: string): never {
  throw new Error(`Invalid appointment job contract: ${type}`);
}
const id = (value: unknown, type: string) => (typeof value === 'string' && UUID.test(value) ? value : invalid(type));
const version = (value: unknown, type: string) => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : invalid(type));
function oneOf<T extends string>(value: unknown, allowed: readonly T[], type: string): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : invalid(type);
}

export async function handleAppointmentJob(
  accountId: string,
  type: AppointmentJobType,
  payload: Record<string, unknown>,
  meta: AppointmentJobMeta,
): Promise<void> {
  void meta;
  const p = payload ?? {};
  switch (type) {
    case APPOINTMENT_JOB_TYPES.reminder:
      await handleAppointmentReminderJob(accountId, {
        appointmentId: id(p.appointmentId, type), version: version(p.version, type), kind: oneOf(p.kind, ['24h', '2h'] as const, type),
      });
      return;
    case APPOINTMENT_JOB_TYPES.notify: {
      const kind = oneOf(p.kind, [...NOTICES, 'hold_reply'] as const, type);
      if (kind === 'hold_reply') {
        const reply: NotifyJobPayload = {
          kind, contactId: id(p.contactId, type), messageId: id(p.messageId, type), reason: oneOf(p.reason, HOLD_REASONS, type),
        };
        await handleHoldReplyJob(accountId, reply);
        return;
      }
      await handleAppointmentNoticeJob(accountId, { appointmentId: id(p.appointmentId, type), version: version(p.version, type), kind });
      return;
    }
    case APPOINTMENT_JOB_TYPES.event:
      await handleAppointmentEventJob(accountId, {
        appointmentId: id(p.appointmentId, type), version: version(p.version, type),
        kind: oneOf<AppointmentEventKind>(p.kind, APPOINTMENT_EVENT_KINDS, type),
      });
      return;
    case APPOINTMENT_JOB_TYPES.holdExpire: {
      const input = { accountId, appointmentId: id(p.appointmentId, type), version: version(p.version, type) };
      await withTenant({ accountId, role: 'owner' }, (tx) => expireHold(tx, input), getWorkerPrisma());
      return;
    }
    case APPOINTMENT_JOB_TYPES.followup:
      await handleAppointmentFollowupJob(accountId, {
        appointmentId: id(p.appointmentId, type), version: version(p.version, type),
        kind: oneOf(p.kind, ['feedback', 'rebook'] as const, type),
      });
      return;
    default:
      invalid(type);
  }
}
