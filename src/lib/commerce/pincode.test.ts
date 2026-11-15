import { describe, expect, it } from 'vitest';
import { parsePincode } from './pincode';

describe('parsePincode', () => {
  it('accepts six digits, ignoring spaces', () => {
    expect(parsePincode('560001')).toBe('560001');
    expect(parsePincode(' 560 001 ')).toBe('560001');
  });
  it('refuses anything else', () => {
    for (const bad of ['56001', '5600011', '056001', 'ABC123', '56000a', '', null, undefined, 560001, {}, ['560001'], '560001\n560002', "560001'; --"])
      expect(parsePincode(bad)).toBeNull();
  });
});

import { hasStateOnlyRate } from './pincode';

describe('hasStateOnlyRate', () => {
  const rate = (over: Record<string, unknown>) => ({ country: 'IN', postalPrefixes: [] as string[], states: [] as string[], ...over });
  it('is true only for a state-only rate', () => {
    expect(hasStateOnlyRate([rate({ states: ['MH'] })])).toBe(true);
    expect(hasStateOnlyRate([rate({ postalPrefixes: ['560'] }), rate({})])).toBe(false);
    expect(hasStateOnlyRate([rate({ postalPrefixes: ['560'], states: ['KA'] })])).toBe(false);
    expect(hasStateOnlyRate([rate({ states: ['MH'], country: 'US' })])).toBe(false);
    expect(hasStateOnlyRate([])).toBe(false);
  });
});
