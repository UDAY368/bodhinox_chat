import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: null as null | { send_window_start: number | null; send_window_end: number | null; send_window_time_zone: string | null },
  enqueued: [] as unknown[][],
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_scope: unknown, fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => (h.row ? [h.row] : []) }),
}));
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: async (...args: unknown[]) => { h.enqueued.push(args); return 'job-2'; } }));

import {
  formatClock, insideWindow, isValidTimeZone, nextWindowOpening, parseClock, requeueForSendWindow, sendWindowError, windowFromRow,
} from './send-window';

const day = { start: 9 * 60, end: 21 * 60, timeZone: 'Asia/Kolkata' };
const night = { start: 22 * 60, end: 6 * 60, timeZone: 'UTC' };

describe('clock helpers', () => {
  it('parses and formats HH:MM', () => {
    expect(parseClock('09:05')).toBe(545);
    expect(parseClock('23:59')).toBe(1439);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('9:05')).toBeNull();
    expect(formatClock(545)).toBe('09:05');
    expect(formatClock(0)).toBe('00:00');
  });

  it('validates windows and time zones', () => {
    expect(sendWindowError(540, 1260)).toBeNull();
    expect(sendWindowError(540, 540)).toMatch(/different/);
    expect(sendWindowError(-1, 10)).toMatch(/valid/);
    expect(sendWindowError(0, 1440)).toMatch(/valid/);
    expect(sendWindowError(1.5, 10)).toMatch(/valid/);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('reads a window from stored columns, ignoring incomplete or invalid ones', () => {
    expect(windowFromRow({ send_window_start: 540, send_window_end: 1260, send_window_time_zone: 'UTC' })).toEqual({ start: 540, end: 1260, timeZone: 'UTC' });
    expect(windowFromRow({ send_window_start: null, send_window_end: null, send_window_time_zone: null })).toBeNull();
    expect(windowFromRow({ send_window_start: 540, send_window_end: null, send_window_time_zone: 'UTC' })).toBeNull();
    expect(windowFromRow({ send_window_start: 540, send_window_end: 1260, send_window_time_zone: 'Gone/Zone' })).toBeNull();
  });
});

describe('insideWindow / nextWindowOpening', () => {
  it('a daytime window in the workspace zone (IST is UTC+5:30)', () => {
    // 03:00 UTC = 08:30 IST: before the window, opens today at 09:00 IST = 03:30 UTC.
    const early = new Date('2026-11-21T03:00:00Z');
    expect(insideWindow(early, day)).toBe(false);
    expect(nextWindowOpening(early, day)?.toISOString()).toBe('2026-11-21T03:30:00.000Z');
    // 10:00 UTC = 15:30 IST: inside.
    expect(insideWindow(new Date('2026-11-21T10:00:00Z'), day)).toBe(true);
    expect(nextWindowOpening(new Date('2026-11-21T10:00:00Z'), day)).toBeNull();
    // 16:00 UTC = 21:30 IST: after the window, opens tomorrow at 09:00 IST.
    expect(nextWindowOpening(new Date('2026-11-21T16:00:00Z'), day)?.toISOString()).toBe('2026-11-22T03:30:00.000Z');
  });

  it('the end minute is outside the window, the start minute inside', () => {
    expect(insideWindow(new Date('2026-11-21T03:30:00Z'), day)).toBe(true);
    expect(insideWindow(new Date('2026-11-21T15:30:00Z'), day)).toBe(false);
  });

  it('a window that spans midnight', () => {
    expect(insideWindow(new Date('2026-11-21T23:00:00Z'), night)).toBe(true);
    expect(insideWindow(new Date('2026-11-21T05:59:00Z'), night)).toBe(true);
    expect(insideWindow(new Date('2026-11-21T12:00:00Z'), night)).toBe(false);
    expect(nextWindowOpening(new Date('2026-11-21T12:00:00Z'), night)?.toISOString()).toBe('2026-11-21T22:00:00.000Z');
  });

  it('rolls over month ends', () => {
    expect(nextWindowOpening(new Date('2026-11-30T22:00:00Z'), { ...day, timeZone: 'UTC' })?.toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });

  it('is DST-safe (London springs forward on 2026-03-29)', () => {
    const london = { start: 9 * 60, end: 17 * 60, timeZone: 'Europe/London' };
    // Saturday 20:00 UTC (GMT) → Sunday 09:00 BST = 08:00 UTC.
    expect(nextWindowOpening(new Date('2026-03-28T20:00:00Z'), london)?.toISOString()).toBe('2026-03-29T08:00:00.000Z');
    // A window opening in the skipped hour (01:30) resolves to just after the jump, never before now.
    const skipped = { start: 90, end: 300, timeZone: 'Europe/London' };
    const opening = nextWindowOpening(new Date('2026-03-29T00:30:00Z'), skipped)!;
    expect(opening.getTime()).toBeGreaterThan(new Date('2026-03-29T00:30:00Z').getTime());
    expect(insideWindow(opening, skipped)).toBe(true);
  });
});

describe('requeueForSendWindow', () => {
  beforeEach(() => { h.row = null; h.enqueued = []; });
  const payload = { broadcastId: 'b-1', scope: 'pending' };

  it('does nothing for a campaign without a window, or inside it', async () => {
    expect(await requeueForSendWindow('a-1', 'b-1', payload, 'job-1')).toBe(false);
    h.row = { send_window_start: 0, send_window_end: 1439, send_window_time_zone: 'UTC' };
    expect(await requeueForSendWindow('a-1', 'b-1', payload, 'job-1', new Date('2026-11-21T12:00:00Z'))).toBe(false);
    expect(h.enqueued).toEqual([]);
  });

  it('outside the window queues one pass for when it opens, deduplicated by the job it replaces', async () => {
    h.row = { send_window_start: 540, send_window_end: 1260, send_window_time_zone: 'UTC' };
    expect(await requeueForSendWindow('a-1', 'b-1', payload, 'job-1', new Date('2026-11-21T22:00:00Z'))).toBe(true);
    expect(h.enqueued).toEqual([['broadcast.dispatch', payload, {
      tenantId: 'a-1', runAt: new Date('2026-11-22T09:00:00Z'), dedupeKey: 'broadcast:b-1:window:job-1',
    }]]);
  });
});
