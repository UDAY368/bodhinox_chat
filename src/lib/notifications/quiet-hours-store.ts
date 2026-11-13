'use client';

/**
 * This tab's copy of the member's quiet hours, so the in-tab desktop alerts
 * (use-browser-notifications) stay quiet too. Loaded by the dashboard
 * listener and updated when Settings › Notifications saves.
 */
import { inQuietWindow, parseClock, type QuietHours } from './quiet-hours';

export const QUIET_HOURS_EVENT = 'bodhinox:quiet-hours';

let current: QuietHours | null = null;

/** Accepts the API's view ({ start: "HH:MM", ... }). */
export function setQuietHours(view: { enabled: boolean; start: string; end: string; time_zone: string; allow_mentions: boolean } | null): void {
  if (!view) {
    current = null;
    return;
  }
  const start = parseClock(view.start);
  const end = parseClock(view.end);
  current = start === null || end === null ? null : { ...view, start, end };
}

/** Whether desktop alerts about new messages are held back right now. */
export function isQuietNow(now: Date = new Date()): boolean {
  return current !== null && inQuietWindow(current, now);
}
