import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { openWindows, shortTimeLeft, windowUrgency } from './session-rail';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const conv = (id: string, last: string | null) => ({ id, last_customer_message_at: last }) as unknown as Conversation;

describe('openWindows', () => {
  it('keeps only open windows, closing-first', () => {
    const list = [conv('fresh', hoursAgo(1)), conv('old', hoursAgo(23.5)), conv('gone', hoursAgo(25)), conv('never', null)];
    expect(openWindows(list, NOW).map((w) => w.conversation.id)).toEqual(['old', 'fresh']);
  });

  it('rolls a chat out once its 24 hours pass', () => {
    const list = [conv('a', hoursAgo(23.9))];
    expect(openWindows(list, NOW)).toHaveLength(1);
    expect(openWindows(list, NOW + 7 * 60_000)).toHaveLength(0);
  });
});

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
