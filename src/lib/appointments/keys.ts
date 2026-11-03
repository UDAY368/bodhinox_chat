/**
 * Every appointment job dedupe key, outbound-intent key, idempotency
 * reference and advisory-lock key, in one place so no two modules spell
 * one differently. jobs.dedupe_key is globally unique, so every job key
 * carries the appointment id; dispatchOnce prefixes the account itself.
 */
import type { AppointmentEventKind, NoticeKind, ReminderKind } from './types';

export const appointmentKeys = {
  /** appointments.reminder job and its dispatchOnce key. */
  reminder: (id: string, version: number, kind: ReminderKind) => `appt-rem:${id}:v${version}:${kind}`,
  /** appointments.notify job (confirmation, rescheduled, cancelled). */
  notify: (id: string, version: number, kind: Exclude<NoticeKind, 'hold_reply'>) => `appt-ntf:${id}:v${version}:${kind}`,
  /** The one reply to an unrecognised or late BOOK code, per inbound message. */
  holdReply: (accountId: string, messageId: string) => `appt-ntf:${accountId}:msg:${messageId}:hold_reply`,
  /** appointments.event job; also the staff-notification dedupe key. */
  event: (id: string, version: number, kind: AppointmentEventKind) => `appt-evt:${id}:v${version}:${kind}`,
  /** appointments.hold_expire job. */
  holdExpire: (id: string, version: number) => `appt-hold:${id}:v${version}`,
  /** appointments.followup feedback message. */
  feedback: (id: string, version: number) => `appt-fbk:${id}:v${version}`,
  /** appointments.followup rebook message (UTILITY only). */
  rebook: (id: string, version: number) => `appt-rbk:${id}:v${version}`,
} as const;

/** Prefix shared by every reminder key of one appointment (retirement queries). */
export const reminderKeyPrefix = (id: string) => `appt-rem:${id}:`;

/** appointments.source_ref values (UNIQUE per account): replaying a booking returns the same row. */
export const sourceRefs = {
  flow: (runId: string, nodeKey: string, transitionSeq: number) => `flow:${runId}:${nodeKey}:${transitionSeq}`,
  public: (pageId: string, requestId: string) => `public:${pageId}:${requestId}`,
} as const;

/**
 * Advisory-lock keys (hashed with hashtextextended(k, 0)). Take them sorted
 * with lockOrder() before any row lock; nothing takes a row lock first.
 */
export const lockKeys = {
  staff: (accountId: string, staffId: string) => `appt:${accountId}:staff:${staffId}`,
  pool: (accountId: string, serviceId: string, locationId: string) => `appt:${accountId}:pool:${serviceId}:${locationId}`,
  contact: (accountId: string, contactId: string) => `appt:${accountId}:contact:${contactId}`,
  /** Offering configuration for one (service, location): pooled xor staffed. */
  config: (accountId: string, serviceId: string, locationId: string) => `appt:cfg:${accountId}:${serviceId}:${locationId}`,
} as const;

/** Unique keys in the one global order every caller uses, so nothing deadlocks. */
export function lockOrder(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort();
}
