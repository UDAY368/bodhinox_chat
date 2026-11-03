import { describe, expect, it } from 'vitest';
import { closureForActiveRun, staleSince } from './engine';
import type { FlowFallbackPolicy } from './types';

// A run waiting on a payment link must outlive the flow's on_timeout_hours
// while the link can still be paid (audit A17).
const flow = { status: 'active' as const, fallback_policy: { on_timeout_hours: 24 } as FlowFallbackPolicy };
const nodes = new Set(['pay']);
const advanced = '2026-11-01T00:00:00.000Z';

describe('payment link wait and run staleness', () => {
  it('counts age from the latest of last advance, delay end and link expiry', () => {
    expect(staleSince({ last_advanced_at: advanced, delay_until: null })).toBe(advanced);
    expect(staleSince({ last_advanced_at: advanced, delay_until: null, wait_until: '2026-11-03T00:00:00.000Z' })).toBe('2026-11-03T00:00:00.000Z');
    expect(staleSince({ last_advanced_at: advanced, delay_until: '2026-11-02T00:00:00.000Z', wait_until: '2026-10-30T00:00:00.000Z' })).toBe('2026-11-02T00:00:00.000Z');
  });

  it('does not time out a run whose link (48h) is still payable at hour 30', () => {
    const run = { current_node_key: 'pay', last_advanced_at: advanced, delay_until: null, wait_until: '2026-11-03T00:00:00.000Z' };
    expect(closureForActiveRun({ run, flow, nodeKeys: nodes, now: new Date('2026-11-02T06:00:00.000Z') })).toBeNull();
    // Without the wait the same run is past its 24h policy.
    expect(closureForActiveRun({ run: { ...run, wait_until: null }, flow, nodeKeys: nodes, now: new Date('2026-11-02T06:00:00.000Z') })?.kind).toBe('timeout');
  });

  it('times the run out once the link expired and the policy elapsed after it', () => {
    const run = { current_node_key: 'pay', last_advanced_at: advanced, delay_until: null, wait_until: '2026-11-03T00:00:00.000Z' };
    expect(closureForActiveRun({ run, flow, nodeKeys: nodes, now: new Date('2026-11-04T00:00:01.000Z') })?.kind).toBe('timeout');
  });
});
