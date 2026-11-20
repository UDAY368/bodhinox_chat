/**
 * Worker lanes (batch 5). Every job type belongs to one lane, and each worker slot claims from one
 * lane, so a slow kind of work never holds up another:
 *
 * - 'inbound': work a customer or member is waiting on. Every type not listed below lands here, so a
 *   new job type is never stranded. Today that is, among others: whatsapp.webhook, inbound.actions
 *   (rules, flows, away messages and AI replies started by a message), instagram.webhook,
 *   instagram.private_reply, meta.page_webhook, meta.leadgen_fetch, meta.capi_event, events.dispatch
 *   (rules, flows and webhooks fired by a domain event), webhook.delivery, api.start_flow,
 *   flow.replay, ai.auto_reply_retry, ai.assess_conversation, ai.auto_label, whatsapp.status_retry,
 *   payment, billing and Zoom provider events, order and appointment notices, refunds and shipments.
 * - 'timers': everything periodic or due at a time: TIMER_JOB_TYPES.
 * - 'bulk': long-running passes and Graph API batches: BULK_JOB_TYPES.
 *
 * WORKER_CONCURRENCY=1 keeps the old single 'all' lane taking every type.
 */
export const BULK_JOB_TYPES = [
  // A campaign pass (time-boxed to about 30 s, then requeued), a crawl slice, a report or export build,
  // an insight run, a catalogue sync or import.
  'broadcast.dispatch', 'ai.crawl_source', 'ai.insight_run', 'analytics.report', 'workspace.export',
  'commerce.catalog_sync', 'commerce.product_import', 'commerce.platform_import',
  // Meta Graph batches: catalogue pushes, ads sync, audience sync, Instagram profiles and tokens.
  'commerce.meta_catalogue_sync', 'commerce.catalog_push', 'meta.insights_sync', 'meta.leads_sync',
  'meta.ad_objects_sync', 'meta.audience_sync', 'instagram.profile_fetch', 'instagram.token_sweep',
  'instagram.resubscribe',
  // Fan-outs to many buyers: back-in-stock and price-drop runs (200 per run), one email-campaign recipient each.
  'commerce.back_in_stock', 'commerce.price_drop', 'shop.email_send',
] as const;

export const TIMER_JOB_TYPES = [
  // Automations and flows on a clock.
  'automation.schedule', 'automation.resume', 'automation.trigger', 'flow.timer', 'flow.sweep', 'sequences.due',
  // Inbox and notification sweeps.
  'inbox.sla_check', 'inbox.auto_resolve', 'inbox.reassign', 'inbox.reminders_due', 'inbox.scheduled_replies_due',
  'inbox.notification_digest', 'inbox.notification_push', 'instagram.ai_comments',
  // Reminders, holds and follow-ups due at a time.
  'appointments.reminder', 'appointments.hold_expire', 'appointments.followup', 'commerce.reservation_expiry',
  'commerce.abandoned_cart', 'commerce.order_followup', 'commerce.review_request', 'commerce.shipment_track',
  'shop.referral_reward',
  // Periodic sweeps, reconciliation, schedules, health and retention.
  'whatsapp.health_sync', 'analytics.report_schedules', 'analytics.report_sweep', 'payments.reconcile_sweep',
  'fulfilment.sweep', 'billing.lifecycle_sweep', 'billing.reconcile', 'usage.housekeeping', 'meta.ad_rules',
  'meta.deal_events', 'workspace.export_sweep', 'workspace.purge', 'workspace.purge_storage',
  'ai.retention_sweep', 'data.retention_sweep',
] as const;

/** 'all': any due job (one-lane worker and tests); otherwise the lane's own types. */
export type JobLane = 'all' | 'inbound' | 'timers' | 'bulk';

const bulk = new Set<string>(BULK_JOB_TYPES);
const timers = new Set<string>(TIMER_JOB_TYPES);

export function jobLane(type: string): Exclude<JobLane, 'all'> {
  return bulk.has(type) ? 'bulk' : timers.has(type) ? 'timers' : 'inbound';
}

export interface LaneSlots { inbound: number; timers: number; bulk: number }
export const DEFAULT_LANE_SLOTS: LaneSlots = { inbound: 2, timers: 1, bulk: 2 };
const MAX_LANE_SLOTS = 8;

function slotCount(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return value >= 1 && value <= MAX_LANE_SLOTS ? value : fallback;
}

/** One slot per lane: what a worker with a small DB_POOL_SIZE runs when no slot count is set. */
export const SMALL_POOL_LANE_SLOTS: LaneSlots = { inbound: 1, timers: 1, bulk: 1 };

/**
 * WORKER_INBOUND_SLOTS, WORKER_TIMER_SLOTS and WORKER_BULK_SLOTS: integers 1 to 8, defaults 2, 1 and 2.
 * When none is set and DB_POOL_SIZE (default 10) is smaller than the defaults need, one slot per lane,
 * so the slots never wait on the pool for connections they cannot get.
 */
export function laneSlots(env: Record<string, string | undefined> = process.env): LaneSlots {
  const explicit = [env.WORKER_INBOUND_SLOTS, env.WORKER_TIMER_SLOTS, env.WORKER_BULK_SLOTS].some((v) => v?.trim());
  const pool = Number(env.DB_POOL_SIZE || '10');
  const defaults = !explicit && Number.isFinite(pool) && pool < workerConnections(DEFAULT_LANE_SLOTS)
    ? SMALL_POOL_LANE_SLOTS : DEFAULT_LANE_SLOTS;
  return {
    inbound: slotCount(env.WORKER_INBOUND_SLOTS, defaults.inbound),
    timers: slotCount(env.WORKER_TIMER_SLOTS, defaults.timers),
    bulk: slotCount(env.WORKER_BULK_SLOTS, defaults.bulk),
  };
}

/**
 * Database connections the worker can hold at once: one per slot, one more per inbound slot (the
 * transaction holding a conversation's advisory lock while its job runs), the scheduler and the
 * heartbeat. Keep it at or below DB_POOL_SIZE (default 10; the defaults need 9).
 */
export function workerConnections(slots: LaneSlots): number {
  return slots.inbound * 2 + slots.timers + slots.bulk + 2;
}

/** One 'all' lane when WORKER_CONCURRENCY=1; otherwise the per-lane slot counts. */
export function workerLanes(env: Record<string, string | undefined> = process.env): JobLane[] {
  if (env.WORKER_CONCURRENCY?.trim() === '1') return ['all'];
  const slots = laneSlots(env);
  return [
    ...Array.from({ length: slots.inbound }, () => 'inbound' as const),
    ...Array.from({ length: slots.timers }, () => 'timers' as const),
    ...Array.from({ length: slots.bulk }, () => 'bulk' as const),
  ];
}

/** Idle wait after `misses` empty claims in a row: 250 ms doubling to `maxMs`; 0 misses means work was found. */
export function idleDelayMs(misses: number, baseMs = 250, maxMs = 5_000): number {
  if (misses <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(misses - 1, 20));
}

/** Inbound waits at most 2 s between polls when idle (a customer may be waiting); other lanes 5 s. */
export function laneIdleMaxMs(lane: JobLane): number {
  return lane === 'inbound' || lane === 'all' ? 2_000 : 5_000;
}

const MAX_KEY = 200;

/** The lane key of a conversation's inbound.actions jobs: they run one at a time, oldest first. */
export function conversationLaneKey(conversationId: string): string {
  return `conversation:${conversationId}`;
}

/**
 * The lane key of a WhatsApp webhook delivery: `wa:<phone number id>:<customer wa id>` when every
 * message and status in it belongs to one chat, else null (template and account updates, or a
 * batch spanning chats, run unkeyed). Deliveries for one chat are then ingested in arrival order.
 */
export function webhookLaneKey(payload: Record<string, unknown>): string | null {
  const keys = new Set<string>();
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown })?.changes) ? (entry as { changes: unknown[] }).changes : [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value || typeof value !== 'object') continue;
      const phoneNumberId = (value.metadata as { phone_number_id?: unknown } | undefined)?.phone_number_id;
      const parties = [
        ...(Array.isArray(value.messages) ? value.messages.map((m: { from?: unknown }) => m?.from) : []),
        ...(Array.isArray(value.statuses) ? value.statuses.map((s: { recipient_id?: unknown }) => s?.recipient_id) : []),
      ];
      for (const party of parties) {
        if (typeof phoneNumberId !== 'string' || typeof party !== 'string') return null;
        keys.add(`wa:${phoneNumberId}:${party}`);
      }
    }
  }
  if (keys.size !== 1) return null;
  const [key] = keys;
  return key.length <= MAX_KEY ? key : null;
}
