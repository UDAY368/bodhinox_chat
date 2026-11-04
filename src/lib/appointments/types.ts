/**
 * Shared appointment contracts (Phase 7). Pure: no server-only imports, so
 * routes, workers, flows and UI agree on one vocabulary. The database CHECK
 * lists in prisma/migrations/20261106100000_appointments mirror these unions.
 */

export const APPOINTMENT_STATUSES = ['held', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** Statuses that occupy a slot (a held row only until hold_expires_at). */
export const ACTIVE_STATUSES = ['held', 'confirmed'] as const satisfies readonly AppointmentStatus[];

export const APPOINTMENT_SOURCES = ['staff', 'public', 'flow'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const APPOINTMENT_EVENT_KINDS = [
  'held', 'confirmed', 'rescheduled', 'reassigned', 'cancelled', 'expired',
  'completed', 'no_show', 'feedback', 'reminder_skipped',
  // Phase 8 paid holds (design E15): waiting for the link, verified capture, a capture after the slot was lost.
  'payment_pending', 'payment_captured', 'late_payment',
  // Phase 9 Zoom meetings: history only (see HISTORY_ONLY_EVENT_KINDS).
  'meeting_created', 'meeting_updated', 'meeting_deleted', 'meeting_sync_failed', 'meeting_joined_provider',
] as const;
export type AppointmentEventKind = (typeof APPOINTMENT_EVENT_KINDS)[number];

/**
 * Event kinds recorded in the appointment history only. They never become an
 * appointments.event job, so they are never fanned out to staff notifications,
 * automations or tenant webhooks, and never retire reminders.
 */
export const HISTORY_ONLY_EVENT_KINDS: ReadonlySet<AppointmentEventKind> = new Set<AppointmentEventKind>([
  'meeting_created', 'meeting_updated', 'meeting_deleted', 'meeting_sync_failed', 'meeting_joined_provider',
]);
export function isHistoryOnlyEventKind(kind: string): boolean {
  return (HISTORY_ONLY_EVENT_KINDS as ReadonlySet<string>).has(kind);
}

export const APPOINTMENT_ACTORS = ['staff', 'customer', 'system'] as const;
export type AppointmentActor = (typeof APPOINTMENT_ACTORS)[number];

export const APPOINTMENT_MESSAGE_KINDS = [
  'confirmation', 'reminder_24h', 'reminder_2h', 'cancelled', 'rescheduled', 'feedback', 'rebook', 'payment_link',
] as const;
export type AppointmentMessageKind = (typeof APPOINTMENT_MESSAGE_KINDS)[number];

export const APPOINTMENT_MESSAGE_STATUSES = ['sent', 'skipped', 'blocked', 'failed', 'outcome_unknown'] as const;
export type AppointmentMessageStatus = (typeof APPOINTMENT_MESSAGE_STATUSES)[number];

/**
 * Online collection for a booking (Phase 8, design E15). none: nothing is
 * collected online (free service, or a staff booking of a paid one); pending:
 * a public hold waiting for its payment link to be paid; paid / refunded: set
 * by the worker after settlement. The app role may only insert 'none'.
 */
export const APPOINTMENT_PAYMENT_STATUSES = ['none', 'pending', 'paid', 'refunded'] as const;
export type AppointmentPaymentStatus = (typeof APPOINTMENT_PAYMENT_STATUSES)[number];

export const CANCEL_REASONS = ['customer', 'staff', 'expired', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const SERVICE_MODES = ['offline', 'online'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export const LOCATION_KINDS = ['physical', 'online'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Kinds a member may create. */
export const TASK_KINDS = ['next_step', 'rebook', 'manual'] as const;
/** Phase 9: opened by the worker only (at most one open task per appointment and kind). */
export const SYSTEM_TASK_KINDS = ['meeting_sync', 'meeting_outcome'] as const;
export type SystemTaskKind = (typeof SYSTEM_TASK_KINDS)[number];
export type TaskKind = (typeof TASK_KINDS)[number] | SystemTaskKind;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type ReminderKind = '24h' | '2h';
/** Customer notices sent by the appointments.notify job. */
export type NoticeKind = 'confirmation' | 'rescheduled' | 'cancelled' | 'hold_reply';

/**
 * Code-only refusals returned to staff, customers and flows. Never carry
 * customer content; the UI translates them (Appointments.errors.*).
 */
export const APPOINTMENT_ERROR_CODES = [
  'slot_unavailable', 'day_not_allowed', 'customer_conflict', 'too_many', 'hold_expired',
  'conflict', 'not_yet_supported', 'not_found', 'invalid', 'feature_unavailable',
] as const;
export type AppointmentErrorCode = (typeof APPOINTMENT_ERROR_CODES)[number];

const ERROR_STATUS: Record<AppointmentErrorCode, number> = {
  slot_unavailable: 409,
  day_not_allowed: 422,
  customer_conflict: 409,
  too_many: 429,
  hold_expired: 410,
  conflict: 409,
  not_yet_supported: 422,
  not_found: 404,
  invalid: 400,
  feature_unavailable: 403,
};

/** A typed, code-only domain refusal. */
export class AppointmentError extends Error {
  readonly status: number;
  constructor(readonly code: AppointmentErrorCode) {
    super(code);
    this.name = 'AppointmentError';
    this.status = ERROR_STATUS[code];
  }
}

export function isAppointmentError(error: unknown): error is AppointmentError {
  return error instanceof AppointmentError;
}

// ------------------------------------------------------------ rows

export interface AppointmentSettingsRow {
  hold_minutes: number;
  max_active_holds_per_page: number;
  min_notice_minutes: number;
  horizon_days: number;
  customer_cancel_cutoff_minutes: number;
  reminder_24h: boolean;
  reminder_2h: boolean;
  staff_notify: boolean;
  confirm_template_name: string | null;
  confirm_template_language: string | null;
  reminder_template_name: string | null;
  reminder_template_language: string | null;
  change_template_name: string | null;
  change_template_language: string | null;
  feedback_template_name: string | null;
  feedback_template_language: string | null;
  rebook_template_name: string | null;
  rebook_template_language: string | null;
}

/** Values used when a workspace has no appointment_settings row yet (match the column defaults). */
export const DEFAULT_APPOINTMENT_SETTINGS: AppointmentSettingsRow = {
  hold_minutes: 15,
  max_active_holds_per_page: 20,
  min_notice_minutes: 60,
  horizon_days: 60,
  customer_cancel_cutoff_minutes: 120,
  reminder_24h: true,
  reminder_2h: true,
  staff_notify: true,
  confirm_template_name: null,
  confirm_template_language: null,
  reminder_template_name: null,
  reminder_template_language: null,
  change_template_name: null,
  change_template_language: null,
  feedback_template_name: null,
  feedback_template_language: null,
  rebook_template_name: null,
  rebook_template_language: null,
};

/** The five settings template slots. */
export const APPOINTMENT_TEMPLATE_SLOTS = ['confirm', 'reminder', 'change', 'feedback', 'rebook'] as const;
export type AppointmentTemplateSlot = (typeof APPOINTMENT_TEMPLATE_SLOTS)[number];

export interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  kind: LocationKind;
  archived_at: Date | null;
}

export interface ServiceRow {
  id: string;
  name: string;
  mode: ServiceMode;
  duration_minutes: number;
  buffer_minutes: number;
  slot_step_minutes: number | null;
  capacity: number;
  price_minor: bigint | number | null;
  currency: string | null;
  payment_required: boolean;
  allowed_weekdays: number[] | null;
  meeting_url: string | null;
  feedback_delay_minutes: number | null;
  rebook_after_days: number | null;
  archived_at: Date | null;
}

export interface StaffRow {
  id: string;
  display_name: string;
  user_id: string | null;
  archived_at: Date | null;
}

export interface OfferingRow {
  id: string;
  service_id: string;
  /** null = a location pool. */
  staff_id: string | null;
  location_id: string;
}

export interface ExceptionRow {
  id: string;
  /** null = the whole location. */
  staff_id: string | null;
  location_id: string;
  /** YYYY-MM-DD local dates, inclusive. */
  starts_on: string;
  ends_on: string;
  /** null = closed all day; else replaces that day's ranges. */
  ranges: { start: string; end: string }[] | null;
  reason: string | null;
}

export interface AppointmentRow {
  id: string;
  contact_id: string | null;
  service_id: string;
  staff_id: string | null;
  location_id: string;
  start_at: Date;
  end_at: Date;
  timezone: string;
  local_date: string;
  status: AppointmentStatus;
  version: number;
  source: AppointmentSource;
  source_ref: string | null;
  booking_page_id: string | null;
  hold_expires_at: Date | null;
  hold_code: string | null;
  confirmed_at: Date | null;
  price_minor: bigint | number | null;
  currency: string | null;
  meeting_url: string | null;
  service_name: string;
  token_epoch: number;
  cancel_reason: CancelReason | null;
  /** Staff-only: routes strip it for members without appointments.manage. */
  outcome_note: string | null;
  feedback_score: number | null;
  /** Phase 8; read by APPOINTMENT_COLUMNS (optional for rows built before it). */
  payment_status?: AppointmentPaymentStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Public intake on a hold (J2 registration); nulled on confirm or expiry. */
export interface BookingIntake {
  name?: string;
  city?: string;
  state?: string;
}

/** One bookable start returned by availability. */
export interface Slot {
  startAt: string;
  endAt: string;
  /** YYYY-MM-DD in the location's zone. */
  localDate: string;
  /** HH:MM in the location's zone. */
  hhmm: string;
  /** Free practitioners (empty for a pool). */
  staffIds: string[];
  remaining: number;
}

// ------------------------------------------------------------ jobs

export const APPOINTMENT_JOB_TYPES = {
  reminder: 'appointments.reminder',
  notify: 'appointments.notify',
  event: 'appointments.event',
  holdExpire: 'appointments.hold_expire',
  followup: 'appointments.followup',
} as const;
export type AppointmentJobType = (typeof APPOINTMENT_JOB_TYPES)[keyof typeof APPOINTMENT_JOB_TYPES];

/**
 * Phase 8 (E15): a paid hold's payment link, created and sent once per hold
 * version. Routed by src/lib/jobs/handlers.ts to paid.ts (not part of
 * APPOINTMENT_JOB_TYPES, whose handler validates only the Phase 7 jobs).
 */
export const APPOINTMENT_PAYMENT_LINK_JOB = 'appointments.payment_link';

export function isAppointmentJobType(type: string): type is AppointmentJobType {
  return (Object.values(APPOINTMENT_JOB_TYPES) as string[]).includes(type);
}

export interface ReminderJobPayload { appointmentId: string; version: number; kind: ReminderKind }
export interface NotifyJobPayload {
  appointmentId?: string;
  version?: number;
  kind: NoticeKind;
  /** hold_reply only: the contact and inbound message that sent an unrecognised code. */
  contactId?: string;
  messageId?: string;
  reason?: 'code_unknown' | 'slot_unavailable' | 'hold_expired' | 'customer_conflict';
  /** confirmation/rescheduled only: the start the notice announces (ISO). */
  startAt?: string;
}
export interface EventJobPayload { appointmentId: string; version: number; kind: AppointmentEventKind }
export interface HoldExpireJobPayload { appointmentId: string; version: number }
export interface FollowupJobPayload { appointmentId: string; version: number; kind: 'feedback' | 'rebook' }

// ------------------------------------------------------------ triggers and webhooks

export const APPOINTMENT_TRIGGER_TYPES = [
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_completed', 'appointment_no_show',
] as const;
export type AppointmentTriggerType = (typeof APPOINTMENT_TRIGGER_TYPES)[number];

export const APPOINTMENT_WEBHOOK_EVENTS = [
  'appointment.booked', 'appointment.cancelled', 'appointment.rescheduled', 'appointment.completed', 'appointment.no_show',
] as const;
export type AppointmentWebhookEvent = (typeof APPOINTMENT_WEBHOOK_EVENTS)[number];

export const APPOINTMENT_NOTIFICATION_TYPES = [
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
] as const;
export type AppointmentNotificationType = (typeof APPOINTMENT_NOTIFICATION_TYPES)[number];

/** Permission keys (FEATURE_PERMISSIONS in src/lib/auth/permissions.ts). */
export const APPOINTMENT_PERMISSIONS = { manage: 'appointments.manage', settings: 'appointments.settings' } as const;

/** Inbound `BOOK <CODE>` confirmation text (after trim + upper-case). */
export const HOLD_CODE_MESSAGE = /^BOOK ([A-HJ-NP-Z2-9]{6})$/;
export const HOLD_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/** The hold code in an inbound "BOOK <CODE>" text, or null. Case and surrounding space are ignored. */
export function parseHoldCodeMessage(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length > 40) return null;
  const match = HOLD_CODE_MESSAGE.exec(text.trim().toUpperCase().replace(/\s+/g, ' '));
  return match ? match[1] : null;
}

/**
 * Durable public-booking limits (enforceAuthRateLimit in src/lib/auth/service.ts;
 * keys are hashed). A 429 AuthError maps to the code-only `too_many`.
 */
export const BOOKING_DURABLE_LIMITS = {
  /** identity: client IP (best effort) */
  createPerIp: { action: 'booking:create:ip', maximum: 20, windowSeconds: 3600 },
  /** identity: sha256 of the manage token */
  managePerToken: { action: 'booking:manage:token', maximum: 30, windowSeconds: 3600 },
  /** identity: the sender's contact id; counts unrecognised BOOK codes */
  badCodePerContact: { action: 'booking:code', maximum: 5, windowSeconds: 3600 },
} as const;

/** Public slot endpoints never return more days than this; staff endpoints up to 14. */
export const PUBLIC_SLOT_DAYS_MAX = 7;
export const STAFF_SLOT_DAYS_MAX = 14;
