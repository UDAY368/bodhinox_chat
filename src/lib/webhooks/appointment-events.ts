import { createAdminClient } from '@/lib/data/admin';
import type { DataClient } from '@/lib/data/types';
import type { AppointmentRow, AppointmentWebhookEvent } from '@/lib/appointments/types';
import { localParts } from '@/lib/appointments/time';
import { dispatchWebhookEvent } from './deliver';

/**
 * Outbound webhooks for appointments: appointment.booked, .cancelled,
 * .rescheduled, .completed and .no_show. Fired by the appointments.event
 * worker job after the change committed (src/lib/appointments/events.ts).
 *
 * The payload carries ids, the service name, UTC and local times, the
 * timezone and the status. Never the staff outcome note, the public intake,
 * the hold code or the manage token (the token is a bearer credential).
 * version, status, start_at, end_at and the local date and time describe the
 * version the event belongs to, even when it is delivered after a later
 * change; staff_id, location_id and timezone are the appointment's current
 * values. Receivers dedupe on data.appointment_id + data.version.
 */

export interface AppointmentWebhookData {
  appointment_id: string;
  version: number;
  status: AppointmentRow['status'];
  source: AppointmentRow['source'];
  contact_id: string | null;
  service_id: string;
  service_name: string;
  staff_id: string | null;
  location_id: string;
  start_at: string;
  end_at: string;
  timezone: string;
  local_date: string;
  local_time: string;
  /** Only for appointment.rescheduled. */
  previous_start_at?: string;
  cancel_reason?: AppointmentRow['cancel_reason'];
  price_minor: number | null;
  currency: string | null;
}

/** The webhook data for an appointment (pure; a fixed allow-list of fields). */
export function appointmentWebhookData(
  row: AppointmentRow, extra: { previousStartAt?: Date | null } = {},
): AppointmentWebhookData {
  const local = localParts(row.start_at, row.timezone);
  const price = row.price_minor == null ? null : Number(row.price_minor);
  return {
    appointment_id: row.id,
    version: row.version,
    status: row.status,
    source: row.source,
    contact_id: row.contact_id,
    service_id: row.service_id,
    service_name: row.service_name,
    staff_id: row.staff_id,
    location_id: row.location_id,
    start_at: row.start_at.toISOString(),
    end_at: row.end_at.toISOString(),
    timezone: row.timezone,
    local_date: local.date,
    local_time: local.hhmm,
    ...(extra.previousStartAt ? { previous_start_at: extra.previousStartAt.toISOString() } : {}),
    ...(row.status === 'cancelled' ? { cancel_reason: row.cancel_reason } : {}),
    price_minor: Number.isSafeInteger(price) ? price : null,
    currency: row.currency,
  };
}

/** Queue one signed delivery per subscribed endpoint. Never throws (dispatchWebhookEvent logs without content). */
export async function emitAppointmentWebhook(
  accountId: string, event: AppointmentWebhookEvent, data: AppointmentWebhookData, db?: DataClient,
): Promise<void> {
  await dispatchWebhookEvent(db ?? createAdminClient({ accountId, role: 'owner' }), accountId, event, data);
}
