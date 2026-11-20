/**
 * Appointment lifecycle into the shared event feed (src/lib/events), in the transaction of the
 * change: enqueueEvent (schedule-jobs.ts) calls this next to the appointments.event job. The
 * feed's events.dispatch job then runs the appointment_* rules, flows and webhooks; the
 * appointments.event job keeps the staff notice and the reminder clean-up.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { emitDomainEvent } from '@/lib/events/emit';
import type { DomainEventType } from '@/lib/events/types';
import { appointmentKeys } from './keys';
import type { AppointmentEventKind } from './types';

/** The lifecycle kinds the feed carries; held, reassigned and the rest stay internal. */
export const APPOINTMENT_DOMAIN_EVENTS: Partial<Record<AppointmentEventKind, DomainEventType>> = {
  confirmed: 'appointment.booked',
  rescheduled: 'appointment.rescheduled',
  cancelled: 'appointment.cancelled',
  completed: 'appointment.completed',
  no_show: 'appointment.no_show',
};

export async function emitAppointmentDomainEvent(
  tx: TenantTransaction, accountId: string, appointmentId: string, version: number, kind: AppointmentEventKind,
): Promise<void> {
  const type = APPOINTMENT_DOMAIN_EVENTS[kind];
  if (!type) return;
  const [row] = await tx.$queryRaw<{
    contact_id: string | null; service_id: string; staff_id: string | null; start_at: Date; timezone: string;
    confirmed_at: Date | null; service_name: string; old_start_at: Date | null; new_start_at: Date | null;
  }[]>`
    SELECT a.contact_id::text AS contact_id, a.service_id::text AS service_id, a.staff_id::text AS staff_id,
      a.start_at, a.timezone, a.confirmed_at, a.service_name, e.old_start_at, e.new_start_at
    FROM appointments a
    LEFT JOIN LATERAL (SELECT old_start_at, new_start_at FROM appointment_events
      WHERE account_id=a.account_id AND appointment_id=a.id AND version=${version} AND kind=${kind}
      ORDER BY created_at LIMIT 1) e ON true
    WHERE a.account_id=${accountId}::uuid AND a.id=${appointmentId}::uuid`;
  if (!row) return;
  // A cancelled hold that was never confirmed is not a booking anyone was told about.
  if (kind === 'cancelled' && !row.confirmed_at) return;
  const start = row.new_start_at ?? row.start_at;
  await emitDomainEvent(tx, {
    accountId,
    type,
    subject: { kind: 'appointment', id: appointmentId },
    contactId: row.contact_id,
    // Ids and times only: never the note, intake or manage link.
    data: {
      appointment_id: appointmentId, version, service_id: row.service_id, service_name: row.service_name.slice(0, 80),
      staff_id: row.staff_id, start_at: start.toISOString(), timezone: row.timezone,
      previous_start_at: kind === 'rescheduled' && row.old_start_at ? row.old_start_at.toISOString() : null,
    },
    dedupeKey: appointmentKeys.event(appointmentId, version, kind),
  });
}
