import { getWorkerPrisma } from '@/lib/db/prisma';
import { evaluateOpsHealth, healthThresholds, readOpsHealth, type DeepHealth, type HealthStatus, type OpsHealthRow } from './health';

/**
 * Secondary alert hook (Phase 15). The worker calls tick() after each scheduling pass; at most every
 * 60 s it reads crm_ops_health() as the worker role and POSTs to OPS_ALERT_WEBHOOK_URL when the status
 * changes, repeating every 15 minutes while it stays `down`. A change to `ok` or `degraded` is sent only
 * once it holds for two consecutive checks (a backlog hovering at the threshold does not flap); `down`
 * is sent at once. State is per process: run one worker replica (docs/deployment/railway.md). Unset URL = no-op with no database read.
 * The payload carries check names and numbers only. It cannot report the worker's own death, which is
 * why an external uptime monitor on /api/health is the primary alert (docs/runbooks/alerts.md).
 */
export type AlertTickResult = 'disabled' | 'skipped' | 'unchanged' | 'held' | 'sent' | 'failed';
export interface OpsAlertPayload {
  source: 'bodhinox-worker';
  /** One-line summary, so chat webhooks that need a `text` field (Slack, Google Chat) accept it. */
  text: string;
  status: HealthStatus;
  previous: HealthStatus;
  failing: string[];
  numbers: Record<string, number | null>;
  at: string;
}
export interface OpsAlerterOptions {
  url?: string;
  read?: () => Promise<OpsHealthRow>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  everyMs?: number;
  repeatDownMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** https only (http only to a loopback host, for local testing); anything else disables the hook. */
export function alertWebhookUrl(raw: string | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url;
  } catch { /* fall through */ }
  return null;
}

/** Names of the checks that are not healthy. */
export function failingChecks(health: DeepHealth, thresholds = healthThresholds()): string[] {
  const { checks } = health;
  const failing: string[] = [];
  if (!checks.appDb) failing.push('appDb');
  if (checks.ops !== 'ok') failing.push('ops');
  if (checks.worker && !checks.worker.ok) failing.push('worker');
  if (checks.queue?.oldestDueS != null && checks.queue.oldestDueS > thresholds.oldestDueDegradedS) failing.push('queue');
  if (checks.intents && checks.intents.unknown > thresholds.unknownIntentsDegraded) failing.push('intents');
  if (checks.webhooks && checks.webhooks.unprocessed15m > 0) failing.push('webhooks');
  return failing;
}

export function alertPayload(health: DeepHealth, previous: HealthStatus, at: Date): OpsAlertPayload {
  const { checks } = health;
  const failing = failingChecks(health);
  return {
    source: 'bodhinox-worker',
    text: `Bodhinox operations: ${health.status} (was ${previous})${failing.length ? `; failing: ${failing.join(', ')}` : ''}`,
    status: health.status,
    previous,
    failing,
    numbers: {
      workerAgeS: checks.worker?.ageS ?? null,
      pendingDue: checks.queue?.pendingDue ?? null,
      oldestDueS: checks.queue?.oldestDueS ?? null,
      expiredLeases: checks.queue?.expiredLeases ?? null,
      failed1h: checks.queue?.failed1h ?? null,
      unknownIntents: checks.intents?.unknown ?? null,
      unprocessedWebhooks15m: checks.webhooks?.unprocessed15m ?? null,
    },
    at: at.toISOString(),
  };
}

export function createOpsAlerter(options: OpsAlerterOptions = {}) {
  const url = alertWebhookUrl(options.url ?? process.env.OPS_ALERT_WEBHOOK_URL);
  const read = options.read ?? (() => readOpsHealth(getWorkerPrisma()));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const everyMs = options.everyMs ?? 60_000;
  const repeatDownMs = options.repeatDownMs ?? 15 * 60_000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const log = options.log ?? ((message: string) => console.error(message));
  // A healthy start is not news; a deploy that starts unhealthy alerts on the first check.
  let reported: HealthStatus = 'ok';
  /** A non-down status seen once, waiting for a second consecutive check before it is sent. */
  let pending: HealthStatus | null = null;
  let lastSentAt = -Infinity;
  let lastCheckAt = -Infinity;
  let running = false;

  async function tick(): Promise<AlertTickResult> {
    if (!url) return 'disabled';
    if (running || now() - lastCheckAt < everyMs) return 'skipped';
    running = true;
    lastCheckAt = now();
    try {
      // The worker is running this code, so its database being reachable is the app-DB signal here.
      const health = evaluateOpsHealth(true, await read().catch(() => 'unavailable' as const));
      const changed = health.status !== reported;
      const repeat = health.status === 'down' && now() - lastSentAt >= repeatDownMs;
      if (!changed) pending = null;
      if (!changed && !repeat) return 'unchanged';
      if (changed && health.status !== 'down' && pending !== health.status) {
        pending = health.status;
        return 'held';
      }
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alertPayload(health, reported, new Date(now()))),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('alert webhook rejected');
      } catch {
        // Keep the old state so the next check retries; never log the URL or the response.
        log('[ops] alert delivery failed');
        return 'failed';
      }
      reported = health.status;
      pending = null;
      lastSentAt = now();
      return 'sent';
    } finally { running = false; }
  }
  return { enabled: !!url, tick };
}
