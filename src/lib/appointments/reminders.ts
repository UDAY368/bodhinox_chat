/**
 * appointments.reminder job (design section 6, APT-04).
 *
 * The version/status recheck here is the guarantee that a cancelled or
 * rescheduled appointment never gets an obsolete reminder (D4): a job queued
 * for an older version records skipped/stale_version and sends nothing.
 * Retiring superseded jobs (events.ts) is hygiene only.
 *
 * Batch 3: inside the customer window the reminder is free-form text with
 * Confirm / Reschedule / Cancel buttons (reminder-actions.ts); outside it the
 * approved appointment_reminder_actions template when there is one, else the
 * settings reminder template. A booking whose chat is on Instagram gets the
 * text there while that window is open (B9).
 */
import { getT } from '@/lib/i18n/translate';
import { appointmentKeys } from './keys';
import { sendCustomerMessage } from './customer-send';
import type { AppointmentRow, ReminderJobPayload, ReminderKind } from './types';

const MINUTE = 60_000;

/** Why a reminder for `version` no longer applies to the row, else null. */
export function reminderApplies(row: AppointmentRow, version: number, kind: ReminderKind, now: Date): string | null {
  if (row.status !== 'confirmed' || row.version !== version) return 'stale_version';
  if (!row.contact_id) return 'contact_missing';
  // A late job never sends a reminder that no longer makes sense.
  const latest = row.start_at.getTime() - (kind === '2h' ? 30 * MINUTE : 120 * MINUTE);
  if (now.getTime() >= latest) return 'past_due';
  return null;
}

export async function handleAppointmentReminderJob(accountId: string, payload: ReminderJobPayload, now = new Date()) {
  const { appointmentId, version, kind } = payload;
  return sendCustomerMessage({
    accountId,
    appointmentId,
    version,
    kind: kind === '24h' ? 'reminder_24h' : 'reminder_2h',
    intentKey: appointmentKeys.reminder(appointmentId, version, kind),
    templateSlot: 'reminder',
    applies: (row, at) => reminderApplies(row, version, kind, at),
    enabled: (settings) => (kind === '24h' ? settings.reminder_24h : settings.reminder_2h),
    freeForm: (ctx) => getT('AppointmentNotices')('reminder', { service: ctx.serviceName, time: ctx.time, location: ctx.location,
      link: ctx.manageLink() }),
    actions: true,
    instagram: true,
    now,
  });
}
