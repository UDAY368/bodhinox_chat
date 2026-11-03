/**
 * appointments.followup job (design section 9): the feedback message after a
 * completed appointment, and the optional rebook message. Both are template
 * sends that must be UTILITY (MARKETING is refused: consent cannot be
 * inferred from a booking, SEC-05). The rebook task itself is created by
 * markOutcome; only the message is sent here.
 */
import { appointmentKeys } from './keys';
import { sendCustomerMessage } from './customer-send';
import type { AppointmentRow, FollowupJobPayload } from './types';

export function followupApplies(row: AppointmentRow, version: number, kind: FollowupJobPayload['kind']): string | null {
  if (row.status !== 'completed' || row.version !== version) return 'stale_version';
  if (kind === 'feedback' && row.feedback_score != null) return 'feedback_recorded';
  return null;
}

export async function handleAppointmentFollowupJob(accountId: string, payload: FollowupJobPayload, now = new Date()) {
  const { appointmentId, version, kind } = payload;
  return sendCustomerMessage({
    accountId,
    appointmentId,
    version,
    kind,
    intentKey: kind === 'feedback' ? appointmentKeys.feedback(appointmentId, version) : appointmentKeys.rebook(appointmentId, version),
    templateSlot: kind,
    applies: (row) => followupApplies(row, version, kind),
    now,
  });
}
