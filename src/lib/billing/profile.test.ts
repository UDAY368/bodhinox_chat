import { describe, expect, it } from 'vitest';
import { gstinCheckChar } from './gst';
import { parseBillingProfile, ProfileInputError } from './profile';

const GSTIN = `29ABCDE1234F1Z${gstinCheckChar('29ABCDE1234F1Z')}`;
const base = { legal_name: 'Acme Pvt Ltd', address_line1: '1 MG Road', city: 'Bengaluru', postal_code: '560001', email: 'Billing@Acme.example' };
const code = (raw: unknown) => {
  try { parseBillingProfile(raw); return null; } catch (e) { return e instanceof ProfileInputError ? e.code : 'other'; }
};

describe('parseBillingProfile', () => {
  it('accepts an Indian profile, taking the state from a valid GSTIN', () => {
    expect(parseBillingProfile({ ...base, gstin: GSTIN.toLowerCase() })).toEqual({
      legalName: 'Acme Pvt Ltd', gstin: GSTIN, addressLine1: '1 MG Road', addressLine2: null, city: 'Bengaluru',
      stateCode: '29', postalCode: '560001', country: 'IN', email: 'billing@acme.example',
    });
  });

  it('rejects a bad checksum, a mismatched state and a missing Indian state', () => {
    const wrong = GSTIN.slice(0, 14) + (GSTIN[14] === 'A' ? 'B' : 'A');
    expect(code({ ...base, gstin: wrong })).toBe('invalid_gstin');
    expect(code({ ...base, gstin: GSTIN, state_code: '27' })).toBe('gstin_state_mismatch');
    expect(code({ ...base })).toBe('state_required');
    expect(code({ ...base, state_code: '00' })).toBe('state_required');
  });

  it('allows a foreign buyer without GSTIN or state, and refuses a GSTIN abroad', () => {
    expect(parseBillingProfile({ ...base, country: 'us', state_code: '29' })).toMatchObject({ country: 'US', stateCode: null, gstin: null });
    expect(code({ ...base, country: 'US', gstin: GSTIN })).toBe('gstin_outside_india');
  });

  it('rejects missing or oversized fields', () => {
    expect(code({ ...base, legal_name: ' ' })).toBe('invalid_profile');
    expect(code({ ...base, state_code: '29', email: 'not-an-email' })).toBe('invalid_profile');
    expect(code({ ...base, state_code: '29', city: 'x'.repeat(101) })).toBe('invalid_profile');
    expect(code(null)).toBe('invalid_profile');
  });
});
