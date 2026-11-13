import { describe, expect, it } from 'vitest';
import { consentView, matchesConsentFilter } from './consent-view';

describe('consentView', () => {
  it('reads no record as none', () => {
    expect(consentView(null)).toEqual({ status: 'none', at: null, source: null });
    expect(consentView({})).toEqual({ status: 'none', at: null, source: null });
  });

  it('shows the opt-in with its time and source', () => {
    expect(consentView({ opted_in_at: '2026-11-10T09:00:00Z', opt_in_source: 'keyword' })).toEqual({
      status: 'opted_in', at: '2026-11-10T09:00:00Z', source: 'keyword',
    });
  });

  it('lets a later opt-out win over the old opt-in', () => {
    const view = consentView({
      opted_in_at: '2026-11-10T09:00:00Z', opt_in_source: 'keyword',
      opted_out_at: '2026-11-12T09:00:00Z', opt_out_source: 'agent',
    });
    expect(view).toEqual({ status: 'opted_out', at: '2026-11-12T09:00:00Z', source: 'agent' });
  });
});

describe('matchesConsentFilter', () => {
  it('filters by status, any matches all', () => {
    const out = { opted_out_at: '2026-11-12T09:00:00Z' };
    expect(matchesConsentFilter(out, 'any')).toBe(true);
    expect(matchesConsentFilter(out, 'opted_out')).toBe(true);
    expect(matchesConsentFilter(out, 'opted_in')).toBe(false);
    expect(matchesConsentFilter(null, 'none')).toBe(true);
  });
});
