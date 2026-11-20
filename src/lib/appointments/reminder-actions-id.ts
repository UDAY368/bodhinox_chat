/**
 * Reminder button ids and tap decisions (batch 3, A5). Pure, no server-only
 * imports: the settings card, the reminder job and the inbound handler share it.
 * See reminder-actions.ts for the flow.
 */
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';
import type { AppointmentRow } from './types';

export type ReminderAction = 'confirm' | 'reschedule' | 'cancel';
/** Button order on the interactive message and the template: Confirm, Reschedule, Cancel. */
export const REMINDER_ACTIONS: readonly ReminderAction[] = ['confirm', 'reschedule', 'cancel'];

/** The template the owner submits from settings (template-library preset of the same name). */
export const REMINDER_ACTIONS_TEMPLATE = 'appointment_reminder_actions';

const CODE: Record<ReminderAction, string> = { confirm: 'c', reschedule: 'r', cancel: 'x' };
const ACTION_OF: Record<string, ReminderAction> = { c: 'confirm', r: 'reschedule', x: 'cancel' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACTION_ID = new RegExp(`^appt:([crx]):(${UUID}):([1-9][0-9]{0,8})$`);

export const reminderActionId = (action: ReminderAction, appointmentId: string, version: number) =>
  `appt:${CODE[action]}:${appointmentId}:${version}`;

export interface ParsedReminderAction { action: ReminderAction; appointmentId: string; version: number }

/** The action of a reminder button id, or null for any other reply id. */
export function parseReminderActionId(replyId: unknown): ParsedReminderAction | null {
  if (typeof replyId !== 'string' || replyId.length > 64) return null;
  const match = ACTION_ID.exec(replyId.toLowerCase());
  return match ? { action: ACTION_OF[match[1]], appointmentId: match[2], version: Number(match[3]) } : null;
}

/**
 * The quick-reply button indexes of an actions template in Confirm, Reschedule,
 * Cancel order, or null when the template is not one (exactly three quick
 * replies and no variable URL button).
 */
export function actionButtonIndexes(template: Pick<MessageTemplate, 'buttons'>): number[] | null {
  const buttons = template.buttons ?? [];
  if (buttons.some((b) => b.type === 'URL' && extractVariableIndices(b.url).length > 0)) return null;
  const quick = buttons.flatMap((b, i) => (b.type === 'QUICK_REPLY' ? [i] : []));
  return quick.length === REMINDER_ACTIONS.length ? quick : null;
}

const MINUTE = 60_000;

/** The same rule as booking.ts assertCustomerCutoff: the customer may still change it online. */
export function customerCanChange(row: Pick<AppointmentRow, 'start_at'>, cutoffMinutes: number, now: Date): boolean {
  return now.getTime() <= row.start_at.getTime() - cutoffMinutes * MINUTE;
}

export type ReminderActionDecision =
  | 'not_ours' | 'stale' | 'already_cancelled' | 'confirm' | 'already_confirmed' | 'cancel' | 'reschedule' | 'too_late';

/** What a tap does (pure; tested). */
export function decideReminderAction(
  row: Pick<AppointmentRow, 'contact_id' | 'status' | 'version' | 'start_at' | 'cancel_reason' | 'attendance_confirmed_at'> | null,
  tap: { contactId: string; action: ReminderAction; version: number },
  cutoffMinutes: number,
  now: Date,
): ReminderActionDecision {
  if (!row || !row.contact_id || row.contact_id !== tap.contactId) return 'not_ours';
  // A replayed Cancel finds its own cancellation: the cancelled notice already answers it.
  if (tap.action === 'cancel' && row.status === 'cancelled' && row.cancel_reason === 'customer' && row.version === tap.version + 1)
    return 'already_cancelled';
  if (row.status !== 'confirmed' || row.version !== tap.version) return 'stale';
  if (tap.action === 'confirm') return row.attendance_confirmed_at ? 'already_confirmed' : 'confirm';
  if (!customerCanChange(row, cutoffMinutes, now)) return 'too_late';
  return tap.action === 'cancel' ? 'cancel' : 'reschedule';
}

/** The reply text key for a decision, or null when nothing is sent. */
export function replyKey(decision: ReminderActionDecision): string | null {
  switch (decision) {
    case 'confirm':
    case 'already_confirmed': return 'actionConfirmed';
    case 'reschedule': return 'actionReschedule';
    case 'too_late': return 'actionTooLate';
    case 'stale': return 'actionStale';
    default: return null;
  }
}
