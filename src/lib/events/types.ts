/**
 * The event feed's vocabulary (standardisation plan section 5, item 1). Pure and client-safe.
 *
 * A domain event is a short record that something happened in a module, written in the same
 * transaction as the change (src/lib/events/emit.ts, or a database trigger for orders, payments,
 * deals and form answers). The worker's 'events.dispatch' job fans each one out once to rules,
 * flows and outbound webhooks; the contact timeline reads the table directly.
 *
 * `data` holds ids, codes, amounts and short labels the staff chose (a service or stage name).
 * Never message text, form answers, notes, phone numbers, addresses or provider tokens: a
 * consumer that needs more reads the subject row through its module.
 */

export const DOMAIN_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.delivered',
  'order.returned',
  'payment.received',
  'form.submitted',
  'deal.stage_changed',
  'cart.abandoned',
  'appointment.booked',
  'appointment.cancelled',
  'appointment.rescheduled',
  'appointment.completed',
  'appointment.no_show',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export const DOMAIN_SUBJECT_KINDS = [
  'order', 'order_return', 'payment', 'form_response', 'deal', 'cart', 'appointment', 'commerce_event',
] as const;
export type DomainSubjectKind = (typeof DOMAIN_SUBJECT_KINDS)[number];

export type DomainEventData = Record<string, string | number | boolean | null>;

export interface DomainEventInput {
  accountId: string;
  type: DomainEventType;
  subject: { kind: DomainSubjectKind; id: string };
  /** The customer the event is about, when there is one; it feeds that contact's timeline. */
  contactId?: string | null;
  /** Flat scalars only, at most DOMAIN_EVENT_DATA_MAX_BYTES as JSON. See the file comment. */
  data: DomainEventData;
  /**
   * Optional. The same key in the same workspace records the event once, so a retried
   * transaction or job never emits it twice (e.g. `appointment:<id>:<version>:<kind>`).
   */
  dedupeKey?: string;
}

export const DOMAIN_EVENT_DATA_MAX_BYTES = 2048;

export function isDomainEventType(value: unknown): value is DomainEventType {
  return typeof value === 'string' && (DOMAIN_EVENT_TYPES as readonly string[]).includes(value);
}

/** Rule (automations.trigger_type) and flow trigger names: the event type with '.' as '_'. */
export const EVENT_TRIGGER_TYPES = [
  'order_created', 'order_paid', 'order_shipped', 'order_delivered', 'order_returned',
  'payment_received', 'form_submitted', 'deal_stage_changed', 'cart_abandoned',
  'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'appointment_completed', 'appointment_no_show',
] as const;
export type EventTriggerType = (typeof EVENT_TRIGGER_TYPES)[number];

/** The rule and flow trigger an event starts. */
export function triggerForEvent(type: DomainEventType): EventTriggerType {
  return type.replace('.', '_') as EventTriggerType;
}

export function isEventTriggerType(value: unknown): value is EventTriggerType {
  return typeof value === 'string' && (EVENT_TRIGGER_TYPES as readonly string[]).includes(value);
}
