import { describe, expect, it } from 'vitest';
import { formatDay, formatLastSeen, formatWhen } from './format';

const t = (key: string, values?: Record<string, string | number>) =>
  key === 'dates.at' ? `${values?.day}, ${values?.time}` : key === 'dates.today' ? 'Today' : key === 'dates.yesterday' ? 'Yesterday' : key;

describe('contact date words', () => {
  const now = new Date(2026, 10, 13, 15, 0);

  it('says today, yesterday, a weekday within the week, then a date', () => {
    expect(formatLastSeen(new Date(2026, 10, 13, 9, 0).toISOString(), 'en', t, now)).toBe('Today');
    expect(formatLastSeen(new Date(2026, 10, 12, 23, 0).toISOString(), 'en', t, now)).toBe('Yesterday');
    expect(formatLastSeen(new Date(2026, 10, 10, 9, 0).toISOString(), 'en', t, now)).toBe('Tue');
    expect(formatLastSeen(new Date(2026, 9, 2, 9, 0).toISOString(), 'en', t, now)).toBe('Oct 2');
    expect(formatLastSeen(new Date(2025, 9, 2, 9, 0).toISOString(), 'en', t, now)).toBe('Oct 2, 2025');
    expect(formatLastSeen('not a date', 'en', t, now)).toBe('');
  });

  it('adds the time for the timeline and shows a full day for Added', () => {
    expect(formatWhen(new Date(2026, 10, 13, 14, 45).toISOString(), 'en', t, now)).toBe('Today, 2:45 PM');
    expect(formatDay(new Date(2026, 9, 12, 12).toISOString(), 'en')).toBe('Oct 12, 2026');
  });
});
