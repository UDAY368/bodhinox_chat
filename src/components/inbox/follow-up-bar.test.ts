import { describe, expect, it } from 'vitest';
import { errorKey, presetTime, toLocalInput } from './follow-up-bar';

describe('presetTime', () => {
  const now = new Date(2026, 10, 12, 14, 30, 0);
  it('adds hours for the short presets', () => {
    expect(presetTime('oneHour', now).getTime() - now.getTime()).toBe(3_600_000);
    expect(presetTime('threeHours', now).getTime() - now.getTime()).toBe(3 * 3_600_000);
  });
  it('means 09:00 local tomorrow and a week on', () => {
    expect(toLocalInput(presetTime('tomorrow', now))).toBe('2026-11-13T09:00');
    expect(toLocalInput(presetTime('nextWeek', now))).toBe('2026-11-19T09:00');
  });
});

describe('errorKey', () => {
  it('maps a known code to its message key and anything else to "failed"', () => {
    expect(errorKey('past', ['past', 'tooFar'])).toBe('past');
    expect(errorKey('instagram_account_disconnected', ['past'])).toBe('failed');
    expect(errorKey(undefined, ['past'])).toBe('failed');
  });
});
