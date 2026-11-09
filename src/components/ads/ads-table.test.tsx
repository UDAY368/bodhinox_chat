import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));

import { formatCount, formatSpend } from './ads-table';

describe('ads table figures', () => {
  it('shows an unknown Meta figure as "-" rather than zero', () => {
    expect(formatCount(null)).toBe('-');
    expect(formatCount(0)).toBe((0).toLocaleString());
    expect(formatCount(1234)).toBe((1234).toLocaleString());
  });

  it('formats a known spend in the ad account currency', () => {
    expect(formatSpend(12.5, 'INR')).toContain('12.50');
  });
});
