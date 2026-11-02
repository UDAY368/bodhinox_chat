import { describe, expect, it } from 'vitest';
import { signupOutcome } from './embedded-signup-button';

const number = { id: 'cfg', phone_number_id: '777', waba_id: '555', display_name: 'Acme', status: 'connected', is_default: true };

describe('signupOutcome', () => {
  it('connects and shows a generated PIN once', () => {
    expect(signupOutcome(true, { number, created: true, pin: '012345' } as never, 'x')).toEqual({ kind: 'connected', number, generatedPin: '012345' });
  });

  it('asks for the existing PIN on a wrong or locked PIN, keeping the row for a retry', () => {
    for (const code of ['pinMismatch', 'pinLocked']) {
      expect(signupOutcome(false, { code, error: 'Wrong PIN', config_id: 'cfg' }, 'x')).toEqual({ kind: 'retryPin', configId: 'cfg', error: 'Wrong PIN', generatedPin: null });
    }
  });

  it('falls back to a plain failure, still surfacing a PIN Meta accepted', () => {
    expect(signupOutcome(false, { code: 'saveFailed', error: 'Save failed', pin: '999999' }, 'x')).toEqual({ kind: 'failed', error: 'Save failed', generatedPin: '999999' });
    expect(signupOutcome(false, { code: 'pinMismatch' }, 'fallback')).toEqual({ kind: 'failed', error: 'fallback', generatedPin: null });
  });
});
