/**
 * appointments.event job (design sections 6, 7 and 10), run after the change
 * committed:
 *  1. retire superseded pending reminder jobs (hygiene only, D4: the
 *     dispatch-time version check is the guarantee);
 *  2. staff notification (deduped per appointment, version and kind);
 *  3. automation trigger appointment_*;
 *  4. outbound webhook appointment.*.
 * Steps 3 and 4 run once each through an outbound intent, so a retried job
 * never fires an automation or webhook twice; an interrupted attempt is left
 * for reconciliation instead.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { getT } from '@/lib/i18n/translate';
import { createNotification, MAX_NOTIFICATION_RECIPIENTS, type NotificationEvent } from '@/lib/inbox/notify';
import { appointmentWebhookData, emitAppointmentWebhook } from '@/lib/webhooks/appointment-events';
import { loadSettings } from './availability';
import { localParts } from './time';
import { getAppointment } from './booking';
import { formatAppointmentTime } from './customer-send';
import { appointmentKeys } from './keys';
import {
  APPOINTMENT_JOB_TYPES, type AppointmentEventKind, type AppointmentRow, type AppointmentTriggerType,
  type AppointmentWebhookEvent, type EventJobPayload,
} from './types';

type Fanout = { trigger: AppointmentTriggerType; webhook: AppointmentWebhookEvent; notification: NotificationEvent | null };

/** What each lifecycle event fans out to. held, reassigned and the rest only retire jobs. */
export const EVENT_FANOUT: Partial<Record<AppointmentEventKind, Fanout>> = {
  confirmed: { trigger: 'appointment_booked', webhook: 'appointment.booked', notification: 'appointment_booked' },
  rescheduled: { trigger: 'appointment_rescheduled', webhook: 'appointment.rescheduled', notification: 'appointment_rescheduled' },
  cancelled: { trigger: 'appointment_cancelled', webhook: 'appointment.cancelled', notification: 'appointment_cancelled' },
  completed: { trigger: 'appointment_completed', webhook: 'appointment.completed', notification: null },
  no_show: { trigger: 'appointment_no_show', webhook: 'appointment.no_show', notification: null },
};

const STAFF_TITLE: Partial<Record<NotificationEvent, string>> = {
  appointment_booked: 'staffBooked',
  appointment_rescheduled: 'staffRescheduled',
  appointment_cancelled: 'staffCancelled',
};

/** Pending reminder jobs of older versions become done/superseded. Returns how many. */
export async function retireSupersededReminders(
  tx: TenantTransaction, accountId: string, appointmentId: string, version: number,
): Promise<number> {
  return tx.$executeRaw`UPDATE jobs SET status='done', last_error='superseded', updated_at=now()
    WHERE tenant_id=${accountId}::uuid AND status='pending' AND type=${APPOINTMENT_JOB_TYPES.reminder}
      AND payload->>'appointmentId'=${appointmentId} AND (payload->>'version')::int < ${version}`;
}

/** The practitioner's linked member if still in the workspace, else owners and admins. */
async function recipients(tx: TenantTransaction, accountId: string, row: AppointmentRow): Promise<string[]> {
  if (row.staff_id) {
    const [linked] = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT m.user_id::text AS user_id FROM appointment_staff s
      JOIN account_memberships m ON m.account_id=s.account_id AND m.user_id=s.user_id
      WHERE s.account_id=${accountId}::uuid AND s.id=${row.staff_id}::uuid`;
    if (linked) return [linked.user_id];
  }
  const admins = await tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id::text AS user_id FROM account_memberships
    WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') ORDER BY user_id LIMIT ${MAX_NOTIFICATION_RECIPIENTS}`;
  return admins.map((r) => r.user_id);
}

const EVENT_STATUS: Partial<Record<AppointmentEventKind, AppointmentRow['status']>> = {
  confirmed: 'confirmed', rescheduled: 'confirmed', cancelled: 'cancelled', completed: 'completed', no_show: 'no_show',
};

/**
 * The appointment as of the event's version, even when the row has moved on
 * since (a backlogged or retried job): that version number and status, and the
 * start time recorded with the event (new_start_at), with end_at shifted by the
 * same delta because a reschedule keeps the duration. Staff, location and
 * timezone are not stored per event, so they are the row's current values.
 */
export function eventSnapshot(
  current: AppointmentRow, version: number, kind: AppointmentEventKind, newStartAt: Date | null,
): AppointmentRow {
  const row: AppointmentRow = { ...current, version, status: EVENT_STATUS[kind] ?? current.status };
  if (!newStartAt || newStartAt.getTime() === current.start_at.getTime()) return row;
  const end = new Date(current.end_at.getTime() + (newStartAt.getTime() - current.start_at.getTime()));
  return { ...row, start_at: newStartAt, end_at: end, local_date: localParts(newStartAt, current.timezone).date };
}

/**
 * Staff alert in its own transaction (deduped per appointment, version and
 * kind, so a retry adds nothing). Never throws: the change already committed.
 */
async function notifyStaff(
  accountId: string, row: AppointmentRow, version: number, kind: AppointmentEventKind, event: NotificationEvent, actorUserId: string | null,
): Promise<void> {
  try {
    await withTenant({ accountId, role: 'owner' }, async (tx) => {
      if (!(await loadSettings(tx, accountId)).staff_notify) return;
      // Fixed text plus the member-chosen service name; never customer content.
      await createNotification(tx, {
        accountId,
        userIds: await recipients(tx, accountId, row),
        event,
        title: getT('AppointmentNotices')(STAFF_TITLE[event]!, {
          service: row.service_name, time: formatAppointmentTime(row.start_at, row.timezone),
        }),
        link: `/appointments?id=${row.id}`,
        dedupeKey: appointmentKeys.event(row.id, version, kind),
        actorUserId,
      });
    }, getWorkerPrisma());
  } catch {
    console.error('[appointments] staff notification failed', { accountId, appointmentId: row.id, version, kind });
  }
}

export async function handleAppointmentEventJob(accountId: string, payload: EventJobPayload): Promise<void> {
  const { appointmentId, version, kind } = payload;
  const fanout = EVENT_FANOUT[kind];
  const context = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const row = await getAppointment(tx, accountId, appointmentId);
    if (!row) return null;
    if (kind !== 'held') await retireSupersededReminders(tx, accountId, appointmentId, version);
    if (!fanout) return null;
    const [event] = await tx.$queryRaw<{ actor_user_id: string | null; old_start_at: Date | null; new_start_at: Date | null }[]>`
      SELECT actor_user_id::text AS actor_user_id, old_start_at, new_start_at FROM appointment_events
      WHERE account_id=${accountId}::uuid AND appointment_id=${appointmentId}::uuid AND version=${version} AND kind=${kind}
      ORDER BY created_at LIMIT 1`;
    // A cancelled hold that was never confirmed is not a booking anyone was told about.
    if (kind === 'cancelled' && !row.confirmed_at) return null;
    // WhatsApp conversations only: the automations this fans out to send over
    // WhatsApp, and a contact linked to an Instagram identity may have a more
    // recently active Instagram thread.
    const [conversation] = row.contact_id ? await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM conversations WHERE account_id=${accountId}::uuid AND contact_id=${row.contact_id}::uuid
        AND channel='whatsapp'
      ORDER BY updated_at DESC LIMIT 1` : [];
    return { row, actorUserId: event?.actor_user_id ?? null, previousStartAt: event?.old_start_at ?? null,
      newStartAt: event?.new_start_at ?? null, conversationId: conversation?.id ?? null };
  }, getWorkerPrisma());
  if (!context || !fanout) return;
  // The event describes its own version even when the row has moved on since.
  const row = eventSnapshot(context.row, version, kind, context.newStartAt);
  const eventKey = appointmentKeys.event(row.id, version, kind);
  if (fanout.notification) await notifyStaff(accountId, row, version, kind, fanout.notification, context.actorUserId);

  if (row.contact_id) {
    const contactId = row.contact_id;
    await dispatchOnce(accountId, `${eventKey}:automations`, async () => ({
      matched: await runAutomationsForTrigger({
        accountId,
        triggerType: fanout.trigger,
        contactId,
        context: {
          service_id: row.service_id,
          ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
          // Ids and times only: never the note, intake or manage link.
          vars: {
            appointment_id: row.id,
            appointment_service: row.service_name,
            appointment_local_time: formatAppointmentTime(row.start_at, row.timezone),
          },
        },
      }),
    }));
  }
  await dispatchOnce(accountId, `${eventKey}:webhook`, async () => {
    await emitAppointmentWebhook(accountId, fanout.webhook,
      appointmentWebhookData(row, kind === 'rescheduled' ? { previousStartAt: context.previousStartAt } : {}));
    return { queued: true };
  });
}
