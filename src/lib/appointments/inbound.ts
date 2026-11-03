/**
 * Inbound "BOOK <CODE>" confirmation (design sections 4 and 5.3, step 4).
 *
 * Called from processInboundActions (inside the inbound job's tenant scope)
 * for a text from a non-blocked contact that is not a STOP/START keyword.
 * confirmHold checks the receiving number is the booking page's, makes the
 * sender the appointment's contact and queues the confirmation and reminders
 * in the same transaction, so this needs no inbound stage checkpoint: a
 * retried job finds the hold already confirmed. A paid service's hold is not
 * confirmed here: the sender is bound and its payment link queued in that
 * transaction (payment_pending), and settlement confirms it (paid.ts).
 *
 * Only a workspace with the appointments feature and a booking page takes
 * part. Text shaped like a code that matches no public appointment there
 * ("book sunday") is ordinary text: it is counted as a miss but handed back
 * to flows, automations, AI and the away message. A real code that is late
 * or conflicting gets one free-form reply (a queued notice job keyed by the
 * inbound message) and keeps the bots silent. Misses count against
 * booking:code:<contactId>; a sender already at that limit never reaches
 * confirmHold, and the text goes to the bots like any other.
 */
import { getAuthPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { AuthError } from '@/lib/auth/errors';
import { hashToken } from '@/lib/auth/csrf';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import { getEntitlements } from '@/lib/billing/entitlements';
import { confirmHold } from './booking';
import { appointmentKeys } from './keys';
import { insertJob } from './schedule-jobs';
import {
  APPOINTMENT_JOB_TYPES, BOOKING_DURABLE_LIMITS, HOLD_CODE, isAppointmentError, type NotifyJobPayload,
} from './types';

export interface BookingCodeInput {
  accountId: string;
  /** Workspace owner used as the send identity (InboundActionsPayload.userId). */
  userId: string;
  /** The WhatsApp sender's own contact (created by ingest). */
  contactId: string;
  conversationId: string;
  /** messages.id of the inbound text. */
  messageId: string;
  /** whatsapp_config.id the message arrived on; null for jobs queued before multi-number. */
  whatsappConfigId: string | null;
  /** Upper-cased six-character code. */
  code: string;
}

export interface BookingCodeResult {
  /** True when the code was processed (confirmed or answered); the bots then stay silent. */
  handled: boolean;
  /** What happened, for tests and logs (codes only). */
  outcome?: 'confirmed' | 'already_confirmed' | 'payment_pending' | NonNullable<NotifyJobPayload['reason']> | 'rate_limited' | 'replayed' | 'not_booking';
}

/** Codes that belong to a real appointment of this workspace and are answered. not_found is not here: it falls through. */
const REPLY_REASONS = {
  hold_expired: 'hold_expired',
  slot_unavailable: 'slot_unavailable',
  customer_conflict: 'customer_conflict',
} as const;

const LIMIT = BOOKING_DURABLE_LIMITS.badCodePerContact;

/**
 * True when the sender already used up the bad-code allowance. Reads the
 * same auth_rate_limits row enforceAuthRateLimit writes, without counting.
 */
async function codeLimitReached(contactId: string): Promise<boolean> {
  const key = hashToken(`${LIMIT.action}:${contactId.trim().toLowerCase()}`);
  const [row] = await getAuthPrisma().$queryRaw<{ attempts: number }[]>`
    SELECT attempts FROM auth_rate_limits WHERE key=${key} AND reset_at>NOW()`;
  return Boolean(row && row.attempts >= LIMIT.maximum);
}

/** Counts one miss; false when that miss went past the limit. */
async function countMiss(accountId: string, contactId: string): Promise<boolean> {
  try {
    await enforceAuthRateLimit(LIMIT.action, contactId, LIMIT.maximum, LIMIT.windowSeconds);
    return true;
  } catch (error) {
    if (error instanceof AuthError && error.status === 429) {
      console.warn('[appointments] booking code limit reached', { accountId, contactId });
      return false;
    }
    throw error;
  }
}

export async function handleBookingCode(input: BookingCodeInput): Promise<BookingCodeResult> {
  const { accountId } = input;
  if (!HOLD_CODE.test(input.code)) return { handled: false };
  const worker = getWorkerPrisma();
  const context = { accountId, role: 'owner' as const };

  // Only a workspace that takes public bookings; anything else is ordinary text.
  const scope = await withTenant(context, async (tx) => {
    const { features } = await getEntitlements(tx, accountId);
    if (!features.appointments) return null;
    const [row] = await tx.$queryRaw<{ pages: boolean; known: boolean; created_at: Date | null }[]>`
      SELECT EXISTS (SELECT 1 FROM booking_pages WHERE account_id=${accountId}::uuid) AS pages,
        EXISTS (SELECT 1 FROM appointments WHERE account_id=${accountId}::uuid AND hold_code=${input.code} AND source='public') AS known,
        (SELECT created_at FROM messages WHERE account_id=${accountId}::uuid AND id=${input.messageId}::uuid) AS created_at`;
    return row ?? null;
  }, worker);
  if (!scope?.pages) return { handled: false, outcome: 'not_booking' };

  // Checked before any code is tried, so the limit bounds guessing, not just replies.
  if (await codeLimitReached(input.contactId)) return { handled: false, outcome: 'rate_limited' };
  if (!scope.known) {
    await countMiss(accountId, input.contactId);
    return { handled: false, outcome: 'code_unknown' };
  }
  // When the message reached us, so queue delay never costs the customer the hold.
  const messageAt = scope.created_at ?? new Date();

  let reason: NonNullable<NotifyJobPayload['reason']>;
  try {
    const result = await withTenant(context, (tx) => confirmHold(tx, {
      accountId, code: input.code, contactId: input.contactId, messageAt, whatsappConfigId: input.whatsappConfigId,
    }), worker);
    return { handled: true, outcome: result.status };
  } catch (error) {
    // Someone else's confirmed code, or the wrong number: a miss, and ordinary text.
    if (isAppointmentError(error) && error.code === 'not_found') {
      await countMiss(accountId, input.contactId);
      return { handled: false, outcome: 'code_unknown' };
    }
    // conflict (a concurrent change) and anything unexpected retry with the inbound job.
    if (!isAppointmentError(error) || !(error.code in REPLY_REASONS)) throw error;
    reason = REPLY_REASONS[error.code as keyof typeof REPLY_REASONS];
  }

  const replyKey = appointmentKeys.holdReply(accountId, input.messageId);
  // A retried inbound job: this message was already answered (and counted).
  const [queued] = await withTenant(context, (tx) => tx.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM jobs WHERE dedupe_key=${replyKey} AND tenant_id=${accountId}::uuid`, worker);
  if (queued) return { handled: true, outcome: 'replayed' };
  if (!(await countMiss(accountId, input.contactId))) return { handled: true, outcome: 'rate_limited' };
  const payload: NotifyJobPayload = { kind: 'hold_reply', contactId: input.contactId, messageId: input.messageId, reason };
  await withTenant(context, (tx) => insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.notify, payload, replyKey), worker);
  return { handled: true, outcome: reason };
}
