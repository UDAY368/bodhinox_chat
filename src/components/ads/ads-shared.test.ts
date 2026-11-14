import { describe, expect, it } from 'vitest';
import { cpm, ctr, customRange, formatPercent, presetRange, ratio, resultKindOf } from './ads-shared';

const NOW = Date.parse('2026-11-20T10:00:00Z');

describe('ranges', () => {
  it("match Meta's fixed ranges, which end yesterday", () => {
    expect(presetRange('last_7d', NOW)).toEqual({ preset: 'last_7d', from: '2026-11-13', to: '2026-11-19' });
    expect(presetRange('last_90d', NOW)).toEqual({ preset: 'last_90d', from: '2026-08-22', to: '2026-11-19' });
  });

  it('orders a custom range and clamps it to 92 days, keeping the end', () => {
    expect(customRange('2026-11-10', '2026-11-01')).toEqual({ preset: 'custom', from: '2026-11-01', to: '2026-11-10' });
    expect(customRange('2026-01-01', '2026-11-19')).toEqual({ preset: 'custom', from: '2026-08-20', to: '2026-11-19' });
  });
});

describe('rates', () => {
  it('give no value instead of a fake 0 when the denominator is 0 or unknown', () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(null, 5)).toBeNull();
    expect(ctr(5, 200)).toBe(2.5);
    expect(ctr(5, 0)).toBeNull();
    expect(cpm(12, 4000)).toBe(3);
    expect(formatPercent(null)).toBe('-');
  });

  it('pick the result each objective is bought for', () => {
    expect(resultKindOf('OUTCOME_LEADS')).toBe('leads');
    expect(resultKindOf('OUTCOME_TRAFFIC')).toBe('link_clicks');
    expect(resultKindOf('OUTCOME_SALES')).toBe('purchases');
    expect(resultKindOf('OUTCOME_ENGAGEMENT')).toBe('conversations');
    expect(resultKindOf(null)).toBe('conversations');
  });
});
