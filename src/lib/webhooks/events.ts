// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound message landed (WhatsApp, or Instagram for endpoints that opted in)
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  'broadcast.completed', // a broadcast finished (no recipient left pending)
  'template.status_updated', // Meta approved/rejected/paused a template
  'flow.completed', // a chatbot flow run reached its end, with collected vars
  'order.created', // a store order was recorded (src/lib/webhooks/commerce-events.ts)
  'order.paid', // a store order was paid
  'payment_link.paid', // a payment link sent from Bodhinox was paid
  'appointment.booked', // an appointment was confirmed (src/lib/webhooks/appointment-events.ts)
  'appointment.cancelled', // an appointment was cancelled
  'appointment.rescheduled', // an appointment moved to a new time
  'appointment.completed', // staff marked an appointment completed
  'appointment.no_show', // staff marked an appointment as a no-show
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'broadcast.completed': 'A broadcast finished sending, with its delivery counts',
  'template.status_updated': 'Meta changed a template status (approved, rejected, paused)',
  'flow.completed': 'A chatbot flow run finished, with the answers it collected',
  'order.created': 'A store order was received (Shopify, WooCommerce or a WhatsApp cart)',
  'order.paid': 'A store order was paid',
  'payment_link.paid': 'A payment link sent from Bodhinox was paid in full',
  'appointment.booked': 'An appointment was booked and confirmed',
  'appointment.cancelled': 'An appointment was cancelled',
  'appointment.rescheduled': 'An appointment was moved to a new time',
  'appointment.completed': 'An appointment was marked completed',
  'appointment.no_show': 'An appointment was marked as a no-show',
};

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

// ------------------------------------------------------------
// Channels (Stage 2). An endpoint lists the channels whose events it
// receives (webhook_endpoints.channels, default {whatsapp}), so an
// existing endpoint never receives Instagram events it did not opt into.
// ------------------------------------------------------------

/** The channels an endpoint can opt into, WhatsApp first. */
export const WEBHOOK_CHANNELS = ['whatsapp', 'instagram'] as const;
export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number];

/**
 * Which channel an event belongs to:
 * - `conversation`: the channel of the conversation it is about (the caller
 *   passes it, or delivery reads it from `data.conversation_id`);
 * - `whatsapp`: a WhatsApp-only event (campaigns, templates);
 * - `workspace`: not tied to a channel (orders, payments, appointments);
 *   every subscribed endpoint receives it, whatever its channels.
 */
export type WebhookEventScope = 'conversation' | 'whatsapp' | 'workspace';

export const WEBHOOK_EVENT_SCOPE: Record<WebhookEvent, WebhookEventScope> = {
  'message.received': 'conversation',
  'message.status_updated': 'conversation',
  'conversation.created': 'conversation',
  'broadcast.completed': 'whatsapp',
  'template.status_updated': 'whatsapp',
  'flow.completed': 'conversation',
  'order.created': 'workspace',
  'order.paid': 'workspace',
  'payment_link.paid': 'workspace',
  'appointment.booked': 'workspace',
  'appointment.cancelled': 'workspace',
  'appointment.rescheduled': 'workspace',
  'appointment.completed': 'workspace',
  'appointment.no_show': 'workspace',
};

export function isWebhookChannel(value: unknown): value is WebhookChannel {
  return typeof value === 'string' && (WEBHOOK_CHANNELS as readonly string[]).includes(value);
}

/**
 * Validate + de-duplicate a caller-supplied channel list, in canonical
 * order. Returns null for anything that is not a non-empty array of known
 * channels (callers turn that into a 400).
 */
export function normalizeWebhookChannels(input: unknown): WebhookChannel[] | null {
  if (!Array.isArray(input) || input.length === 0 || !input.every(isWebhookChannel)) return null;
  return WEBHOOK_CHANNELS.filter((channel) => input.includes(channel));
}

/** An endpoint row's channels; a missing value reads as the column default. */
export function endpointChannels(value: unknown): WebhookChannel[] {
  return Array.isArray(value) ? value.filter(isWebhookChannel) : ['whatsapp'];
}
