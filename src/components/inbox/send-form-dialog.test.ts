import { describe, expect, it } from 'vitest';
import { sendFormRejectedDefinitely } from './send-form-dialog';

describe('sendFormRejectedDefinitely (R8/R11)', () => {
  it('gets a new request id after a refusal or a Meta rejection, since nothing was sent', () => {
    expect(sendFormRejectedDefinitely(400, undefined)).toBe(true);
    expect(sendFormRejectedDefinitely(404, 'form_not_found')).toBe(true);
    expect(sendFormRejectedDefinitely(409, 'window_closed')).toBe(true);
    expect(sendFormRejectedDefinitely(429, undefined)).toBe(true);
    expect(sendFormRejectedDefinitely(502, undefined)).toBe(true);
  });

  it('keeps the request id when the outcome is unknown, so it is never sent twice', () => {
    expect(sendFormRejectedDefinitely(409, undefined)).toBe(false);
    expect(sendFormRejectedDefinitely(500, undefined)).toBe(false);
    expect(sendFormRejectedDefinitely(503, undefined)).toBe(false);
    expect(sendFormRejectedDefinitely(504, undefined)).toBe(false);
  });
});
