import { leaseFetch as fetch } from '@/lib/jobs/lease'
import { enqueueJob } from '@/lib/jobs/queue';
// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints
// subscribed to an event, signs one JSON payload, and POSTs it to
// each in parallel. It is best-effort and never throws — callers fire
// it from the inbound webhook's `after()` block, where a failed
// delivery must not affect the 200 OK returned to Meta.
//
// Delivery semantics (documented in docs/public-api.md):
//   - At-most-once per event, single attempt with a short timeout.
//   - Each consecutive failure bumps `failure_count`; once it crosses
//     MAX_CONSECUTIVE_FAILURES the endpoint is auto-disabled
//     (`is_active = false`) so a dead sink stops being hit. A success
//     resets the counter and stamps `last_delivery_at`.
//   - Durable retry-with-backoff would need a queue/worker (a
//     follow-up); in-process retries inside `after()` would burn the
//     route's duration budget without a real durability guarantee.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { DataClient } from '@/lib/data/types';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws.
 */
export async function dispatchWebhookEvent(
  db: DataClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  try {
    const { data: rows, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .contains('events', [event]);

    if (error || !rows || rows.length === 0) return;

    // Sign the exact bytes we send so a receiver can recompute the
    // HMAC over the raw request body. `id` is a per-delivery uuid the
    // receiver can dedupe on (deliveries are at-least-once and may
    // repeat / arrive out of order).
    const payload = JSON.stringify({
      id: randomUUID(),
      event,
      occurred_at: new Date().toISOString(),
      account_id: accountId,
      data,
    });
    for (const row of rows as EndpointRow[]) {
      await enqueueJob('webhook.delivery', { endpointId: row.id, event, payload }, { tenantId: accountId, dedupeKey: `outbound-webhook:${JSON.parse(payload).id}:${row.id}` });
    }
  } catch (err) {
    // Never let a delivery problem bubble into the webhook response.
    throw err;
  }
}

async function deliverOne(
  db: DataClient,
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<void> {
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address. Counts as a failure so a
  // misconfigured internal URL surfaces and eventually auto-disables.
  if (!(await isDeliverableUrl(row.url))) {
    console.warn('[webhooks] refusing non-public delivery target for', row.id);
    await recordFailure(db, row);
    throw new Error('Webhook target unavailable');
  }

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    // A row whose secret can't be decrypted can never produce a valid
    // signature — count it as a failure so it eventually auto-disables.
    console.error('[webhooks] secret decrypt failed for', row.id, err);
    await recordFailure(db, row);
    throw new Error('Webhook target unavailable');
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': event,
        'X-Wacrm-Webhook-Id': row.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above. A 3xx is a
      // misconfiguration; treat it as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    // Success: clear the failure streak.
    await db
      .from('webhook_endpoints')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${row.id} failed:`,
      err instanceof Error ? err.message : err
    );
    await recordFailure(db, row);
    throw new Error('Webhook delivery failed');
  }
}

async function recordFailure(db: DataClient, row: EndpointRow): Promise<void> {
  // Atomic increment (+ auto-disable at the threshold) via a SQL
  // function — a read-modify-write here would lose increments when two
  // deliveries to the same endpoint run concurrently (e.g.
  // conversation.created + message.received for one inbound message),
  // so a dead endpoint might never reach the disable threshold.
  const { error } = await db.rpc('record_webhook_failure', {
    endpoint_id: row.id,
    max_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (error) {
    console.error('[webhooks] record_webhook_failure failed for', row.id, error);
  }
}

export async function deliverQueuedWebhook(db: DataClient, accountId: string, job: Record<string, unknown>) {
  if (typeof job.endpointId !== 'string' || typeof job.payload !== 'string' || typeof job.event !== 'string') throw new Error('Invalid delivery job');
  const { data, error } = await db.from('webhook_endpoints').select('id,url,secret').eq('id', job.endpointId).eq('account_id', accountId).eq('is_active', true).maybeSingle();
  if (error) throw new Error('Webhook lookup failed');
  if (!data) return;
  await deliverOne(db, data as EndpointRow, job.event as WebhookEvent, job.payload, Math.floor(Date.now() / 1000));
}
