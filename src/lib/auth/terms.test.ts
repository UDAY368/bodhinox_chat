import { describe, expect, it } from 'vitest';
import { assertTermsAccepted, currentTermsVersion } from './service';

describe('terms acceptance', () => {
  it('changes nothing while TERMS_VERSION is unset', () => {
    expect(currentTermsVersion({})).toBeNull();
    expect(assertTermsAccepted(undefined, {})).toBeNull();
    expect(assertTermsAccepted('anything', {})).toBeNull();
  });

  it('requires the current version once TERMS_VERSION is set', () => {
    const env = { TERMS_VERSION: '2026-11' };
    expect(assertTermsAccepted('2026-11', env)).toBe('2026-11');
    expect(() => assertTermsAccepted(undefined, env)).toThrow(expect.objectContaining({ status: 400, code: 'terms_required' }));
    expect(() => assertTermsAccepted('2026-01', env)).toThrow(expect.objectContaining({ code: 'terms_required' }));
  });
});
