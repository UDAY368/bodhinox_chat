// Stage 5 (5D): the pure maths of a timed pause of automated replies, shared
// by the server (src/lib/inbox/automation-pause.ts, bot-pause.ts) and the
// inbox control. No database imports, so client components can use it.

/** The pause state as stored on a conversation row. */
export interface PauseRow {
  bot_paused?: boolean | null;
  bot_paused_until?: string | Date | null;
}

/**
 * Whether automated replies are paused now: bot_paused is set and either no
 * end time (until resumed) or an end time still in the future. An unreadable
 * time counts as until resumed, so nothing resumes by accident.
 */
export function pauseActive(row: PauseRow | null | undefined, now: Date = new Date()): boolean {
  if (!row?.bot_paused) return false;
  if (row.bot_paused_until === null || row.bot_paused_until === undefined) return true;
  const until = new Date(row.bot_paused_until).getTime();
  return Number.isNaN(until) || until > now.getTime();
}

/** When a pause of `minutes` started at `now` ends; null for until resumed. */
export function pauseEndsAt(minutes: number | null, now: Date = new Date()): Date | null {
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}
