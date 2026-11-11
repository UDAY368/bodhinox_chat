import { describe, expect, it } from 'vitest';
import { formatRate, parseDelayInput, scheduleLabel, windowWarning } from './sequence-format';

describe('sequence display helpers', () => {
  it('shows a dash, not 0%, when nothing was counted', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(67)).toBe('67%');
  });

  it('labels the first message from subscribing and later ones from the previous message', () => {
    expect(scheduleLabel(0, 0, 'minutes')).toEqual({ kind: 'immediately', anchor: 'first' });
    expect(scheduleLabel(0, 2, 'hours')).toEqual({ kind: 'after', amount: 2, unit: 'hours', anchor: 'first' });
    expect(scheduleLabel(3, 1, 'days')).toEqual({ kind: 'after', amount: 1, unit: 'days', anchor: 'previous' });
    expect(scheduleLabel(1, 0, 'days')).toEqual({ kind: 'immediately', anchor: 'previous' });
  });

  it('accepts the delay the server accepts, typed as text', () => {
    expect(parseDelayInput(' 3 ', 'days')).toEqual({ amount: 3, unit: 'days' });
    expect(parseDelayInput('0', 'minutes')).toEqual({ amount: 0, unit: 'minutes' });
    for (const bad of ['', '-1', '1.5', '2e3', 'abc', '366']) expect(parseDelayInput(bad, 'days'), bad).toBeNull();
    expect(parseDelayInput('8761', 'hours')).toBeNull();
  });

  it('warns on any Instagram delay longer than 24 hours', () => {
    expect(windowWarning(24, 'hours')).toBe(false);
    expect(windowWarning(25, 'hours')).toBe(true);
    expect(windowWarning(2, 'days')).toBe(true);
    expect(windowWarning(1440, 'minutes')).toBe(false);
  });
});
