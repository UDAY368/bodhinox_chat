// ============================================================
// Quiet hours for campaigns (batch 7). A campaign may carry a send window:
// start and end as minutes after local midnight in an IANA time zone (the
// workspace's when the campaign was created). start > end spans midnight
// (22:00–06:00). Outside the window the dispatcher does not send: the pass
// stops and one job is queued for the moment the window opens, so nothing
// busy-loops. The maths is pure and DST-safe; unit-tested.
// ============================================================

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';

export interface SendWindow {
  /** Minutes after local midnight, 0–1439. */
  start: number;
  end: number;
  timeZone: string;
}

const DAY_MINUTES = 1440;

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "09:00" → 540; null when malformed. */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** 540 → "09:00". */
export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** Offset of the zone from UTC at an instant, in ms (east positive). */
function offsetAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of a local wall-clock time. A time skipped by a DST jump resolves to just after the jump. */
function zonedInstant(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let instant = guess - offsetAt(guess, timeZone);
  instant = guess - offsetAt(instant, timeZone);
  return instant;
}

/** Local minutes after midnight (with seconds as a fraction). */
function localMinutes(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  return p.h * 60 + p.min + p.s / 60;
}

export function insideWindow(now: Date, window: SendWindow): boolean {
  const m = localMinutes(now.getTime(), window.timeZone);
  return window.start < window.end
    ? m >= window.start && m < window.end
    : m >= window.start || m < window.end;
}

/**
 * When the window next opens, or null when `now` is inside it. Outside a window
 * the next opening is later today when the local time is before `start`, else
 * tomorrow (this holds for midnight-spanning windows too).
 */
export function nextWindowOpening(now: Date, window: SendWindow): Date | null {
  if (insideWindow(now, window)) return null;
  const p = zonedParts(now.getTime(), window.timeZone);
  const m = p.h * 60 + p.min + p.s / 60;
  const dayOffset = m < window.start ? 0 : 1;
  // Date.UTC normalises day overflow (31 + 1 → next month).
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d + dayOffset));
  const opening = zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), window.start, window.timeZone);
  // Never earlier than a second from now, so a requeue cannot spin.
  return new Date(Math.max(opening, now.getTime() + 1000));
}

/** A window from stored columns; null when the campaign has none (or a stored zone is no longer valid). */
export function windowFromRow(row: { send_window_start: number | null; send_window_end: number | null; send_window_time_zone: string | null }): SendWindow | null {
  if (row.send_window_start === null || row.send_window_end === null || !row.send_window_time_zone) return null;
  if (row.send_window_start === row.send_window_end || !isValidTimeZone(row.send_window_time_zone)) return null;
  return { start: row.send_window_start, end: row.send_window_end, timeZone: row.send_window_time_zone };
}

/** Validates a window from the wizard; returns an error message or null. */
export function sendWindowError(start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start >= DAY_MINUTES || end >= DAY_MINUTES)
    return 'Choose a valid send window';
  if (start === end) return 'The send window must start and end at different times';
  return null;
}

/**
 * Read by the dispatcher: the time a campaign's window next opens, or null when
 * it has no window or is inside it now.
 */
export async function broadcastWindowWait(accountId: string, broadcastId: string, now = new Date()): Promise<Date | null> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{
    send_window_start: number | null; send_window_end: number | null; send_window_time_zone: string | null;
  }[]>`SELECT send_window_start, send_window_end, send_window_time_zone FROM broadcasts
    WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
  const window = rows[0] ? windowFromRow(rows[0]) : null;
  return window ? nextWindowOpening(now, window) : null;
}

/**
 * Called by the dispatcher before a pass and after a pass stopped: outside the
 * campaign's window, queue this same pass for the moment the window opens and
 * return true (the caller then sends nothing). One job replaces one job, so
 * waiting never multiplies passes; the delivery lock still serialises them.
 */
export async function requeueForSendWindow(accountId: string, broadcastId: string, payload: Record<string, unknown>, jobId: string, now = new Date()): Promise<boolean> {
  const opensAt = await broadcastWindowWait(accountId, broadcastId, now);
  if (!opensAt) return false;
  await enqueueJob('broadcast.dispatch', payload, {
    tenantId: accountId,
    runAt: opensAt,
    dedupeKey: `broadcast:${broadcastId}:window:${jobId}`,
  });
  return true;
}
