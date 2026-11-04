import { describe, expect, it } from 'vitest';
import { MARKETING_OPT_IN_VERSION, marketingConsentRefusal } from './marketing-consent';

describe('marketingConsentRefusal (Phase 9 D13)', () => {
  const contact = { blocked_at: null, opted_out_at: null };
  it('allows only an explicit opt-in', () => {
    expect(marketingConsentRefusal({ marketing_opt_in: true }, contact)).toBeNull();
    expect(marketingConsentRefusal({ marketing_opt_in: false }, contact)).toBe('no_marketing_consent');
    expect(marketingConsentRefusal({ marketing_opt_in: null }, contact)).toBe('no_marketing_consent');
  });
  it('refuses a blocked contact and an opt-out at any time, even before the purchase', () => {
    expect(marketingConsentRefusal({ marketing_opt_in: true }, { ...contact, blocked_at: new Date() })).toBe('contact_blocked');
    expect(marketingConsentRefusal({ marketing_opt_in: true }, { ...contact, opted_out_at: new Date('2020-01-01T00:00:00Z') })).toBe('opted_out');
  });
  it('records a wording version the database accepts', () => {
    expect(MARKETING_OPT_IN_VERSION).toMatch(/^[a-z0-9_]{1,32}$/);
  });
});
