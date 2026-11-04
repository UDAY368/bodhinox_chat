// Phase 11 T5: an Instagram refusal in the storefront sender becomes one of
// the storefront's own fixed codes, decided before any outbound intent.
import { describe, expect, it } from 'vitest';
import { INSTAGRAM_ERROR_CODES, InstagramError } from '@/lib/instagram/errors';
import { StoreError } from './store-settings';
import { storeErrorFromInstagram } from './storefront';

describe('storeErrorFromInstagram', () => {
  it('maps every Instagram refusal to a fixed storefront code without Meta text', () => {
    const expected: Record<string, string> = {
      instagram_window_closed: 'outside_window', contact_blocked: 'contact_blocked', invalid_request: 'invalid', not_found: 'contact_not_found',
    };
    for (const code of INSTAGRAM_ERROR_CODES) {
      const mapped = storeErrorFromInstagram(new InstagramError(code));
      expect(mapped).toBeInstanceOf(StoreError);
      expect((mapped as StoreError).code).toBe(expected[code] ?? 'number_unavailable');
      if (!(code in expected)) expect((mapped as StoreError).detail).toEqual({ channel: 'instagram', reason: code });
    }
  });

  it('passes anything else through unchanged', () => {
    const error = new Error('boom');
    expect(storeErrorFromInstagram(error)).toBe(error);
  });
});
