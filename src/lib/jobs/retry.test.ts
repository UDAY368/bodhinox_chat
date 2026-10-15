import { describe, expect, it } from 'vitest';
import { retryDecision } from './retry';

describe('durable job recovery', () => {
  it('backs off retryable failures and terminates at the attempt budget', () => {
    expect(retryDecision({ attempts: 1, maxAttempts: 3, uncertain: false })).toEqual({ status: 'pending', delayMs: 2000 });
    expect(retryDecision({ attempts: 3, maxAttempts: 3, uncertain: false })).toEqual({ status: 'failed', delayMs: 0 });
  });
  it('never blindly resends after an uncertain provider outcome', () => {
    expect(retryDecision({ attempts: 1, maxAttempts: 5, uncertain: true })).toEqual({ status: 'failed', delayMs: 0 });
  });
});
