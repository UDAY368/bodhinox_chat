// A campaign's "Send at" is picked as a wall-clock time in the workspace time zone
// (Settings > Workspace), not the browser's. Pure, so the wizard and its tests share it.
import { zonedWallToUtc } from '@/lib/appointments/time';

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The UTC instant of a `datetime-local` value ("YYYY-MM-DDTHH:MM") read in `timeZone`. Null for
 * an unreadable value or zone, and for a time that does not exist there (a daylight-saving gap).
 */
export function scheduleLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  try {
    return zonedWallToUtc(m[1], m[2], timeZone);
  } catch {
    return null; // An unknown zone name.
  }
}

/** The browser's own zone, used only when the workspace zone cannot be read. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
