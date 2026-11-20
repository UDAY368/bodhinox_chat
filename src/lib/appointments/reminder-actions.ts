/**
 * Reminder buttons (batch 3, A5): Confirm / Reschedule / Cancel inside the chat.
 *
 * A reminder carries three reply ids `appt:<c|r|x>:<appointmentId>:<version>`:
 * as interactive reply buttons inside the customer window, or as the
 * quick-reply payloads of the approved `appointment_reminder_actions`
 * template outside it (customer-send.ts). A tap reaches handleReminderAction
 * from processInboundActions (WhatsApp only).
 *
 * Only the appointment's own contact may act; any other sender's tap, or a
 * forged id, is ordinary text for the bots. A tap for an older version or a
 * booking that is no longer confirmed gets a polite "out of date" reply.
 *  - Confirm: attendance_confirmed_at once, with an attendance_confirmed event
 *    (no version bump, so the reminders stay valid). A second tap only thanks again.
 *  - Cancel: cancelAppointment as the customer, under the customer cut-off. The
 *    cancelled notice it queues is the reply; past the cut-off the customer is
 *    told to write to the business instead.
 *  - Reschedule: never moves anything; replies with the manage link (or the
 *    cut-off message).
 * The state change is local and replay-safe on its own; the one reply is an
 * outbound intent keyed by the inbound message, run inside the caller's stage
 * checkpoint, so a retried job never answers twice. Logs carry ids and codes only.
 */
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { engineSendText } from '@/lib/automations/meta-send';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isSuspended } from '@/lib/billing/suspension';
import { getT } from '@/lib/i18n/translate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { loadSettings } from './availability';
import { cancelAppointment, getAppointment } from './booking';
import { deriveManageToken, manageUrl } from './tokens';
import { decideReminderAction, parseReminderActionId, replyKey, type ReminderActionDecision } from './reminder-actions-id';

export {
  actionButtonIndexes, customerCanChange, decideReminderAction, parseReminderActionId, REMINDER_ACTIONS,
  REMINDER_ACTIONS_TEMPLATE, reminderActionId, replyKey,
} from './reminder-actions-id';
export type { ParsedReminderAction, ReminderAction, ReminderActionDecision } from './reminder-actions-id';

/** The one reply to a tap, per inbound message (dispatchOnce prefixes the account). */
export const reminderActionReplyKey = (accountId: string, messageId: string) => `appt-act:${accountId}:msg:${messageId}`;

export interface ReminderActionInput {
  accountId: string;
  /** The sender, as resolved by the inbound pipeline. */
  contactId: string;
  conversationId: string;
  /** messages.id of the inbound tap. */
  messageId: string;
  replyId: string | null | undefined;
  now?: Date;
}

export interface ReminderActionResult {
  /** True when the tap was the appointment's own contact's: bots and the away message then stay silent. */
  handled: boolean;
  outcome: ReminderActionDecision | 'ignored';
}

export async function handleReminderAction(
  input: ReminderActionInput,
  /** Wraps the one send (the inbound job passes its stage checkpoint); the state change before it is replay-safe. */
  runSend: (send: () => Promise<unknown>) => Promise<unknown> = (send) => send(),
): Promise<ReminderActionResult> {
  const parsed = parseReminderActionId(input.replyId);
  if (!parsed) return { handled: false, outcome: 'ignored' };
  const { accountId } = input;
  const now = input.now ?? new Date();
  const claim = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const row = await getAppointment(tx, accountId, parsed.appointmentId, true);
    const settings = await loadSettings(tx, accountId);
    const decision = decideReminderAction(row, { contactId: input.contactId, ...parsed }, settings.customer_cancel_cutoff_minutes, now);
    if (decision === 'not_ours' || !row) return { decision: 'not_ours' as const };
    if (decision === 'confirm') {
      const updated = await tx.$executeRaw`UPDATE appointments SET attendance_confirmed_at=${now}, updated_at=now()
        WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid AND version=${row.version} AND attendance_confirmed_at IS NULL`;
      if (updated) await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor)
        VALUES(${row.id}::uuid,${row.version},'attendance_confirmed','customer')`;
    }
    if (decision === 'cancel') {
      await cancelAppointment(tx, { accountId, appointmentId: row.id, reason: 'customer', expectedVersion: parsed.version,
        actor: 'customer', now });
    }
    return {
      decision,
      suspended: await isSuspended(tx, accountId),
      serviceName: row.service_name,
      manageLink: manageUrl(deriveManageToken(row.id, row.token_epoch)),
    };
  }, getWorkerPrisma());
  if (claim.decision === 'not_ours') return { handled: false, outcome: 'ignored' };

  const key = replyKey(claim.decision);
  if (!key || claim.suspended) return { handled: true, outcome: claim.decision };
  const text = getT('AppointmentNotices')(key, { service: claim.serviceName, link: claim.manageLink });
  await runSend(async () => {
    try {
      const db = createAdminClient({ accountId, role: 'owner' });
      const userId = await resolveAuditUserId(db, accountId);
      await dispatchOnce(accountId, reminderActionReplyKey(accountId, input.messageId), () => engineSendText({
        accountId, userId, conversationId: input.conversationId, contactId: input.contactId, text, serviceMessage: true,
      }));
    } catch (error) {
      // A provider rejection sent nothing and is not retried; an uncertain send propagates to the stage checkpoint.
      if (!(error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500)) throw error;
      console.warn('[appointments] reminder action reply rejected', { accountId, messageId: input.messageId });
    }
  });
  return { handled: true, outcome: claim.decision };
}
