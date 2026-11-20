/**
 * The optional filters an event trigger takes, shared by rules (automations.trigger_config) and
 * flows (flows.trigger_config). Pure and client-safe.
 *
 * Each filter names one field of the event's data (src/lib/events/types.ts payload shapes); an
 * empty or absent filter matches every event of the type. Appointment triggers keep the
 * `service_ids` list they always had.
 */
import { EVENT_TRIGGER_TYPES, type EventTriggerType } from './types';

/** The order sources a `source` filter may name (orders_source_check). */
export const EVENT_ORDER_SOURCES = ['whatsapp', 'shopify', 'woocommerce', 'manual', 'storefront'] as const;

/** The single-value filters of each event trigger: config key -> event data field. */
export const EVENT_TRIGGER_FILTERS: Record<EventTriggerType, readonly string[]> = {
  order_created: ['source'],
  order_paid: ['source'],
  order_shipped: ['source'],
  order_delivered: ['source'],
  // order.returned carries no source.
  order_returned: [],
  payment_received: [],
  form_submitted: ['form_id'],
  deal_stage_changed: ['pipeline_id', 'to_stage_id'],
  cart_abandoned: [],
  appointment_booked: [],
  appointment_cancelled: [],
  appointment_rescheduled: [],
  appointment_completed: [],
  appointment_no_show: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The domain-feed triggers that are new in batch 5 (the appointment ones existed before). */
export const NEW_EVENT_TRIGGER_TYPES = EVENT_TRIGGER_TYPES.filter((t) => !t.startsWith('appointment_')) as EventTriggerType[];

export function isAppointmentTrigger(trigger: string): boolean {
  return trigger.startsWith('appointment_');
}

const configOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Whether an event's data passes the trigger's filters. Every non-empty filter must equal the
 * event's field; `service_ids` (appointments) lists the services that start it.
 */
export function eventFiltersMatch(trigger: EventTriggerType, rawConfig: unknown, data: Record<string, unknown> | null | undefined): boolean {
  const config = configOf(rawConfig);
  const event = data ?? {};
  if (isAppointmentTrigger(trigger)) {
    const ids = config.service_ids;
    if (!Array.isArray(ids) || ids.length === 0) return true;
    return typeof event.service_id === 'string' && ids.includes(event.service_id);
  }
  return EVENT_TRIGGER_FILTERS[trigger].every((field) => {
    const want = config[field];
    if (want === undefined || want === null || want === '') return true;
    return event[field] !== undefined && event[field] !== null && String(event[field]) === String(want);
  });
}

/** The config keys of a trigger's filters that are malformed (an id that is not a uuid, an unknown source). */
export function eventFilterProblems(trigger: EventTriggerType, rawConfig: unknown): string[] {
  const config = configOf(rawConfig);
  const problems: string[] = [];
  if (isAppointmentTrigger(trigger)) {
    const ids = config.service_ids;
    if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length > 50
      || ids.some((v) => typeof v !== 'string' || !UUID.test(v)))) problems.push('service_ids');
    return problems;
  }
  for (const field of EVENT_TRIGGER_FILTERS[trigger]) {
    const value = config[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') { problems.push(field); continue; }
    if (field === 'source' ? !(EVENT_ORDER_SOURCES as readonly string[]).includes(value) : !UUID.test(value)) problems.push(field);
  }
  // A stage filter belongs to a pipeline: a stage alone cannot be checked against its pipeline.
  if (trigger === 'deal_stage_changed' && config.to_stage_id && !config.pipeline_id) problems.push('pipeline_id');
  return problems;
}

/** The message variables an event trigger offers (eventVars in src/lib/events/vars.ts), for the builders. */
export const EVENT_TRIGGER_VARS: Record<EventTriggerType, readonly string[]> = {
  order_created: ['event_order_id', 'event_source', 'event_status', 'event_total_minor', 'event_currency', 'event_item_count'],
  order_paid: ['event_order_id', 'event_source', 'event_status', 'event_total_minor', 'event_currency', 'event_item_count'],
  order_shipped: ['event_order_id', 'event_source', 'event_status', 'event_total_minor', 'event_currency', 'event_item_count'],
  order_delivered: ['event_order_id', 'event_source', 'event_status', 'event_total_minor', 'event_currency', 'event_item_count'],
  order_returned: ['event_order_id', 'event_return_id'],
  payment_received: ['event_payment_id', 'event_order_id', 'event_amount_minor', 'event_currency', 'event_method'],
  form_submitted: ['event_form_id', 'event_response_id'],
  deal_stage_changed: ['event_deal_id', 'event_pipeline_id', 'event_to_stage_id', 'event_stage_name', 'event_value', 'event_currency'],
  cart_abandoned: ['event_session_id', 'event_total_minor', 'event_currency', 'event_item_count'],
  appointment_booked: ['appointment_id', 'appointment_service', 'appointment_local_time'],
  appointment_cancelled: ['appointment_id', 'appointment_service', 'appointment_local_time'],
  appointment_rescheduled: ['appointment_id', 'appointment_service', 'appointment_local_time'],
  appointment_completed: ['appointment_id', 'appointment_service', 'appointment_local_time'],
  appointment_no_show: ['appointment_id', 'appointment_service', 'appointment_local_time'],
};
