import { enqueueJob } from '@/lib/jobs/queue';
// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints subscribed to
// an event and queues one signed `webhook.delivery` job per endpoint; the
// worker POSTs it (`deliverQueuedWebhook`) and throws on failure so the job
// queue retries with exponential backoff (WEBHOOK_DELIVERY_MAX_ATTEMPTS
// attempts over roughly a quarter of an hour). Delivery is at-least-once:
// receivers dedupe on the payload `id`.
//
// Every attempt is logged in webhook_deliveries (bounded: newest 100 per
// endpoint, 30 days; never the payload) through record_webhook_attempt(),
// which also keeps the failure streak. An endpoint is switched off only after
// sustained failure: at least MIN_FAILURES_BEFORE_DISABLE failed attempts in a
// row over at least DISABLE_AFTER_FAILING_MINUTES. Then disabled_at and
// disabled_reason say why in Settings, and the owners and admins get an
// in-app notification (type webhook_disabled).
// ============================================================

import { randomUUID } from 'node:crypto';

import type { DataClient } from '@/lib/data/types';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { safeFetch } from '@/lib/webhooks/safe-fetch';
import { endpointChannels, WEBHOOK_EVENT_SCOPE, type WebhookChannel, type WebhookEvent } from '@/lib/webhooks/events';
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { getT } from '@/lib/i18n/translate';
import { createNotification, MAX_NOTIFICATION_RECIPIENTS } from '@/lib/inbox/notify';

/** Per-attempt HTTP timeout. */
export const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Attempts per event. The queue backs off 2 s, 4 s, ... capped at 5 min, so 10 attempts span
 * about 13 minutes: a receiver restart or a short outage no longer loses the event.
 */
export const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 10;

/** An endpoint is switched off only after this many failed attempts in a row ... */
export const MIN_FAILURES_BEFORE_DISABLE = 15;
/** ... spanning at least this long with no successful delivery (24 hours). */
export const DISABLE_AFTER_FAILING_MINUTES = 24 * 60;

/** Where the disable notice sends admins. */
const SETTINGS_LINK = '/settings?tab=api';

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

export interface DispatchWebhookOptions {
  /**
   * The channel of a conversation event, when the caller already read it from
   * the conversation row. Without it, delivery reads the channel of
   * `data.conversation_id` (no id: WhatsApp, the pre-Instagram default).
   */
  channel?: WebhookChannel;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The channel an event belongs to, or null for a workspace event every subscriber receives. */
async function eventChannel(db: DataClient, accountId: string, event: WebhookEvent, data: unknown,
  given: WebhookChannel | undefined): Promise<WebhookChannel | null> {
  const scope = WEBHOOK_EVENT_SCOPE[event];
  if (scope === 'workspace') return null;
  if (scope === 'whatsapp') return 'whatsapp';
  if (given) return given;
  const conversationId = (data as { conversation_id?: unknown } | null)?.conversation_id;
  if (typeof conversationId !== 'string' || !UUID.test(conversationId)) return 'whatsapp';
  const { data: row, error } = await db.from('conversations').select('channel')
    .eq('account_id', accountId).eq('id', conversationId).maybeSingle();
  // Fail closed: never guess a channel and send an Instagram event to a WhatsApp-only endpoint.
  if (error) throw new Error('Webhook channel lookup failed');
  return (row as { channel?: string | null } | null)?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

/**
 * Queue `event` (+ `data`) for every active endpoint of `accountId`
 * subscribed to it and, for a channel event, opted into that channel
 * (webhook_endpoints.channels; existing endpoints are WhatsApp-only). A
 * channel event's envelope carries `channel`. Throws when the queue cannot
 * persist the job or a conversation's channel cannot be read.
 */
export async function dispatchWebhookEvent(
  db: DataClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown,
  options: DispatchWebhookOptions = {}
): Promise<void> {
  const { data: subscribed, error } = await db
    .from('webhook_endpoints')
    .select('id, url, secret, channels')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .contains('events', [event]);

  if (error || !subscribed || subscribed.length === 0) return;

  const channel = await eventChannel(db, accountId, event, data, options.channel);
  const rows = (subscribed as (EndpointRow & { channels?: unknown })[])
    .filter((row) => channel === null || endpointChannels(row.channels).includes(channel));
  if (rows.length === 0) return;

  // Sign the exact bytes we send so a receiver can recompute the
  // HMAC over the raw request body. `id` is a per-delivery uuid the
  // receiver can dedupe on (deliveries are at-least-once and may
  // repeat / arrive out of order).
  const payload = JSON.stringify({
    id: randomUUID(),
    event,
    occurred_at: new Date().toISOString(),
    account_id: accountId,
    ...(channel ? { channel } : {}),
    data,
  });
  for (const row of rows) {
    await enqueueJob('webhook.delivery', { endpointId: row.id, event, payload }, {
      tenantId: accountId,
      dedupeKey: `outbound-webhook:${JSON.parse(payload).id}:${row.id}`,
      maxAttempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS,
    });
  }
}

/** What one attempt produced, for the delivery log (codes only, never the reply body). */
interface Attempt {
  delivered: boolean;
  httpStatus: number | null;
  error: string | null;
}

async function attemptOne(
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<Attempt> {
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address. Counts as a failure so a misconfigured
  // internal URL surfaces in the log and eventually disables the endpoint.
  if (!(await isDeliverableUrl(row.url)))
    return { delivered: false, httpStatus: null, error: 'blocked_target' };

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch {
    // A row whose secret can't be decrypted can never produce a valid signature.
    return { delivered: false, httpStatus: null, error: 'secret_unreadable' };
  }

  // safeFetch dials only the address it checked (closing the DNS-rebinding
  // gap between the check above and the connect), never follows redirects
  // (a 3xx is a misconfiguration and counts as a failure) and holds the
  // job lease. Success is judged on the status alone: the reply body is
  // never read, so a large or slow body cannot fail an accepted delivery.
  try {
    const res = await safeFetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': event,
        'X-Wacrm-Webhook-Id': row.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
    }, { timeoutMs: DELIVERY_TIMEOUT_MS, discardBody: true });
    if (!res.ok) return { delivered: false, httpStatus: null, error: errorCode(res.error) };
    if (res.status < 200 || res.status >= 300)
      return { delivered: false, httpStatus: validStatus(res.status), error: 'http_status' };
    return { delivered: true, httpStatus: validStatus(res.status), error: null };
  } catch {
    return { delivered: false, httpStatus: null, error: 'request_failed' };
  }
}

function validStatus(status: number): number | null {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}
/** A short [a-z0-9_] code (the log's check constraint), never free text. */
export function errorCode(error: unknown): string {
  const code = String(error ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return code || 'unreachable';
}

/**
 * Logs the attempt and keeps the failure streak in one atomic call (two deliveries to one
 * endpoint can run concurrently). Returns true when this attempt switched the endpoint off.
 */
async function recordAttempt(
  db: DataClient,
  row: EndpointRow,
  event: WebhookEvent,
  deliveryId: string | null,
  attempt: number,
  result: Attempt
): Promise<boolean> {
  const { data, error } = await db.rpc('record_webhook_attempt', {
    p_endpoint_id: row.id,
    p_event: event,
    p_delivery_id: deliveryId,
    p_attempt: attempt,
    p_delivered: result.delivered,
    p_http_status: result.httpStatus ?? 0, // 0 = no HTTP reply; stored as NULL
    p_error: result.error,
    p_min_failures: MIN_FAILURES_BEFORE_DISABLE,
    p_disable_after_minutes: DISABLE_AFTER_FAILING_MINUTES,
  });
  if (error) {
    // Ids only: the endpoint URL and payload stay out of logs.
    console.error('[webhooks] record_webhook_attempt failed for', row.id);
    return false;
  }
  return data === true;
}

/** In-app notice to the workspace's owners and admins that an endpoint was switched off. */
async function notifyDisabled(accountId: string, endpoint: EndpointRow): Promise<void> {
  const t = getT('Settings.webhooks.notifications');
  let host = 'webhook';
  try {
    host = new URL(endpoint.url).host;
  } catch {
    // keep the generic name
  }
  const hours = Math.round(DISABLE_AFTER_FAILING_MINUTES / 60);
  const title = t('disabledTitle', { host }).slice(0, 200);
  const body = t('disabledBody', { host, hours }).slice(0, 1000);
  await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [stamp] = await tx.$queryRaw<{ epoch: string }[]>`
      SELECT floor(extract(epoch FROM disabled_at))::bigint::text AS epoch FROM webhook_endpoints
      WHERE account_id=${accountId}::uuid AND id=${endpoint.id}::uuid`;
    const admins = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id::text AS user_id FROM account_memberships
      WHERE account_id=${accountId}::uuid AND role IN ('owner','admin') ORDER BY user_id LIMIT ${MAX_NOTIFICATION_RECIPIENTS}`;
    // Through createNotification, so each member's webhook_disabled preference decides in-app
    // and email digest, and the dedupe key (bound to the disable time) sends one notice per disable.
    await createNotification(tx, {
      accountId,
      userIds: admins.map((row) => row.user_id),
      event: 'webhook_disabled',
      title,
      body,
      link: SETTINGS_LINK,
      dedupeKey: `webhook-disabled:${endpoint.id}:${stamp?.epoch ?? '0'}`,
    });
  }, getWorkerPrisma());
}

function deliveryIdOf(payload: string): string | null {
  try {
    const id = (JSON.parse(payload) as { id?: unknown }).id;
    return typeof id === 'string' ? id.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** One attempt of a queued delivery; `attempt` is the job's attempt number (1-based). */
export async function deliverQueuedWebhook(db: DataClient, accountId: string, job: Record<string, unknown>, attempt = 1) {
  if (typeof job.endpointId !== 'string' || typeof job.payload !== 'string' || typeof job.event !== 'string') throw new Error('Invalid delivery job');
  const { data, error } = await db.from('webhook_endpoints').select('id,url,secret').eq('id', job.endpointId).eq('account_id', accountId).eq('is_active', true).maybeSingle();
  if (error) throw new Error('Webhook lookup failed');
  if (!data) return;
  const row = data as EndpointRow;
  const event = job.event as WebhookEvent;
  const result = await attemptOne(row, event, job.payload, Math.floor(Date.now() / 1000));
  const disabledNow = await recordAttempt(db, row, event, deliveryIdOf(job.payload), Math.max(1, attempt), result);
  if (disabledNow) {
    try {
      await notifyDisabled(accountId, row);
    } catch {
      console.error('[webhooks] disable notice failed for', row.id);
    }
  }
  if (!result.delivered) {
    console.warn(`[webhooks] delivery to ${row.id} failed: ${result.error}${result.httpStatus ? ` (${result.httpStatus})` : ''}`);
    // Throw so the queue retries with backoff; once disabled, the next attempt is a no-op.
    throw new Error(result.error === 'blocked_target' || result.error === 'secret_unreadable'
      ? 'Webhook target unavailable' : 'Webhook delivery failed');
  }
}
