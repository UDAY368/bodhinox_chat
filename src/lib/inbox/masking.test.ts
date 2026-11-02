import { describe, expect, it } from 'vitest';
import { displayPhone, maskPhone, maskPhonesInText, shouldMask } from './masking';

describe('maskPhone', () => {
  it.each([
    ['+919876543210', '+91 98•••••210'],
    ['919876543210', '+91 98•••••210'],
    ['+1 (415) 555-0123', '+1 41•••••123'],
    ['+447911123456', '+44 79•••••456'],
    ['+5511987654321', '+55 11••••••321'],
    ['+351912345678', '+351 91••••678'],
    ['9876543210', '98•••••210'],
    ['12345', '•••45'],
    ['', ''],
  ])('%s -> %s', (input, expected) => expect(maskPhone(input)).toBe(expected));

  it('never leaves the middle digits visible', () => {
    expect(maskPhone('+919876543210')).not.toContain('6543');
  });
  it('handles null', () => expect(maskPhone(null)).toBe(''));
});

describe('shouldMask', () => {
  it('never masks owners or admins', () => {
    expect(shouldMask('owner', { mask_phone_numbers: true })).toBe(false);
    expect(shouldMask('admin', { mask_phone_numbers: true })).toBe(false);
  });
  it('masks agents and viewers only when the flag is set', () => {
    expect(shouldMask('agent', { mask_phone_numbers: true })).toBe(true);
    expect(shouldMask('viewer', { mask_phone_numbers: true })).toBe(true);
    expect(shouldMask('agent', { mask_phone_numbers: false })).toBe(false);
    expect(shouldMask('agent', null)).toBe(false);
  });
});

describe('displayPhone', () => {
  it('masks on request and keeps null', () => {
    expect(displayPhone('+919876543210', true)).toBe('+91 98•••••210');
    expect(displayPhone('+919876543210', false)).toBe('+919876543210');
    expect(displayPhone(null, true)).toBeNull();
  });
});

describe('maskPhonesInText', () => {
  it('masks phone-looking runs in free text and keeps everything else', () => {
    expect(maskPhonesInText('Chat from +919876543210 assigned')).toBe('Chat from +91 98•••••210 assigned');
    expect(maskPhonesInText('Call (415) 555-0101 now')).not.toContain('555-0101');
    expect(maskPhonesInText('+44 7700 900123')).toBe(maskPhone('+44 7700 900123'));
    expect(maskPhonesInText('Due 2026-11-02, waited 45 minutes, 1,500 sent, order 12345')).toBe(
      'Due 2026-11-02, waited 45 minutes, 1,500 sent, order 12345');
    expect(maskPhonesInText('id abc98765432100')).toBe('id abc98765432100');
    expect(maskPhonesInText('')).toBe('');
    expect(maskPhonesInText(null)).toBeNull();
    expect(maskPhonesInText(undefined)).toBeUndefined();
  });
});
