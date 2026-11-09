/**
 * Wait after the Nth failed attempt: 10 s, 1 min, 5 min, 20 min, 1 h, 2 h, then 4 h. A dependency
 * that is down for minutes (file storage, a customer's webhook endpoint, a saturated pool) is ridden
 * out instead of burning every attempt within about 30 seconds.
 */
const BACKOFF_MS = [10_000, 60_000, 300_000, 1_200_000, 3_600_000, 7_200_000, 14_400_000];

export function retryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(Math.trunc(attempts), 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

/** Default attempt budget: 5 attempts, retried over about 26 minutes. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * Idempotent messaging work (inbound processing, flow timers, outbound webhooks) gets 8 attempts,
 * retried over about 7.5 hours: losing one is a customer message or automation that never happens.
 * Each re-checks its own state (receipt status, stage checkpoints, timer seq, per-delivery id).
 */
export const LONG_RETRY_ATTEMPTS = 8;
const LONG_RETRY_TYPES = new Set(['whatsapp.webhook', 'inbound.actions', 'flow.timer', 'webhook.delivery']);

export function defaultMaxAttempts(type: string): number {
  return LONG_RETRY_TYPES.has(type) ? LONG_RETRY_ATTEMPTS : DEFAULT_MAX_ATTEMPTS;
}

export function retryDecision({ attempts, maxAttempts, uncertain }: { attempts: number; maxAttempts: number; uncertain: boolean }): { status: 'pending' | 'failed'; delayMs: number } {
  if (uncertain || attempts >= maxAttempts) return { status: 'failed', delayMs: 0 };
  return { status: 'pending', delayMs: retryDelayMs(attempts) };
}
