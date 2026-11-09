import { describe, expect, it } from 'vitest';
import { defaultMaxAttempts, LONG_RETRY_ATTEMPTS, retryDecision, retryDelayMs } from './retry';

describe('durable job recovery', () => {
  it('backs off retryable failures and terminates at the attempt budget', () => {
    expect(retryDecision({ attempts: 1, maxAttempts: 3, uncertain: false })).toEqual({ status: 'pending', delayMs: 10_000 });
    expect(retryDecision({ attempts: 3, maxAttempts: 3, uncertain: false })).toEqual({ status: 'failed', delayMs: 0 });
  });
  it('never blindly resends after an uncertain provider outcome', () => {
    expect(retryDecision({ attempts: 1, maxAttempts: 5, uncertain: true })).toEqual({ status: 'failed', delayMs: 0 });
  });
  it('[audit-38] spreads retries over minutes to hours, not seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryDelayMs)).toEqual(
      [10_000, 60_000, 300_000, 1_200_000, 3_600_000, 7_200_000, 14_400_000, 14_400_000, 14_400_000]);
    expect(retryDelayMs(0)).toBe(10_000);
    const total = (max: number) => Array.from({ length: max - 1 }, (_, i) => retryDelayMs(i + 1)).reduce((a, b) => a + b, 0);
    // Default budget: about 26 minutes before the fifth failure is final.
    expect(total(defaultMaxAttempts('automation.resume'))).toBe(1_570_000);
    // Messaging work: over 7 hours before the eighth failure is final.
    expect(total(LONG_RETRY_ATTEMPTS)).toBeGreaterThan(7 * 3_600_000);
  });
  it('gives idempotent messaging job types the long attempt budget', () => {
    for (const type of ['whatsapp.webhook', 'inbound.actions', 'flow.timer', 'webhook.delivery']) expect(defaultMaxAttempts(type)).toBe(8);
    for (const type of ['broadcast.dispatch', 'automation.schedule', 'ai.assess_conversation']) expect(defaultMaxAttempts(type)).toBe(5);
  });
});
