import { describe, expect, it } from 'vitest';
import { rowWindow, shortTimeLeft, windowUrgency } from './session-rail';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('windowUrgency and shortTimeLeft', () => {
  it('marks soon under 2h and closing under 30m', () => {
    expect(windowUrgency(3 * 3_600_000)).toBe('ok');
    expect(windowUrgency(90 * 60_000)).toBe('soon');
    expect(windowUrgency(10 * 60_000)).toBe('closing');
  });

  it('formats hours, then minutes, never 0m', () => {
    expect(shortTimeLeft(22.7 * 3_600_000)).toBe('22h');
    expect(shortTimeLeft(45 * 60_000)).toBe('45m');
    expect(shortTimeLeft(10_000)).toBe('1m');
  });
});

describe('rowWindow', () => {
  it('is null once the 24 hours pass or there was no customer message', () => {
    expect(rowWindow(hoursAgo(25), NOW)).toBeNull();
    expect(rowWindow(null, NOW)).toBeNull();
  });

  it('reports time left and share of the day', () => {
    const w = rowWindow(hoursAgo(22), NOW)!;
    expect(w.left).toBe('2h');
    expect(w.urgency).toBe('ok');
    expect(w.share).toBeCloseTo(2 / 24);
  });
});
