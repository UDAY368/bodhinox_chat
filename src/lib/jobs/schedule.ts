import { CronExpressionParser } from 'cron-parser'

const MINUTE = 60_000
const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE

/**
 * Up to an hour of minutes the scheduler missed (a long job, a restart or a deploy) is caught up;
 * an occurrence older than that is skipped rather than fired hours late.
 */
export const SCHEDULE_CATCH_UP_MINUTES = 60

/** UTC ISO occurrence keys prevent duplicate dispatch within a scheduled minute. */
export function scheduledSlot(schedule: string, timezone: string, now: Date): string | null {
  const minute = new Date(floorMinute(now.getTime()))
  return scheduledSlotsBetween(schedule, timezone, minute, minute)[0] ?? null
}

/**
 * Every occurrence of a five-field cron schedule in the whole minutes from `from` to `to`
 * (inclusive), as UTC ISO slot keys. Bounded by SCHEDULE_CATCH_UP_MINUTES; an invalid schedule
 * yields none.
 */
export function scheduledSlotsBetween(schedule: string, timezone: string, from: Date, to: Date): string[] {
  try {
    if (schedule.trim().split(/\s+/).length !== 5) return []
    const end = floorMinute(to.getTime())
    const start = Math.max(floorMinute(from.getTime()), end - (SCHEDULE_CATCH_UP_MINUTES - 1) * MINUTE)
    const cron = CronExpressionParser.parse(schedule, { currentDate: new Date(start - 1), tz: timezone })
    const slots: string[] = []
    for (let i = 0; i < SCHEDULE_CATCH_UP_MINUTES; i++) {
      const next = cron.next().toDate()
      if (next.getTime() > end) break
      slots.push(next.toISOString())
    }
    return slots
  } catch { return [] }
}

/**
 * The minutes the next automation.schedule pass covers: from the minute after the last one already
 * queued (at most SCHEDULE_CATCH_UP_MINUTES back) to the current minute. `missed` counts minutes
 * older than the catch-up window. With nothing queued before, or the current minute already
 * covered, it is the current minute alone (re-evaluating it is harmless: slots are deduplicated).
 */
export function scheduleRange(last: Date | null, now: number): { from: Date; to: Date; missed: number } {
  const to = floorMinute(now)
  const earliest = to - (SCHEDULE_CATCH_UP_MINUTES - 1) * MINUTE
  const next = last ? floorMinute(last.getTime()) + MINUTE : to
  const from = next > to ? to : Math.max(next, earliest)
  return { from: new Date(from), to: new Date(to), missed: next < earliest ? (earliest - next) / MINUTE : 0 }
}

/** The covered range of a queued automation.schedule payload; an old payload without `from` is its minute alone. */
export function payloadRange(payload: Record<string, unknown>, now = Date.now()): { from: Date; to: Date } {
  const parse = (value: unknown) => (typeof value === 'string' ? new Date(value) : null)
  const minute = parse(payload.minute)
  const to = minute && !Number.isNaN(minute.getTime()) ? new Date(floorMinute(minute.getTime())) : new Date(floorMinute(now))
  const from = parse(payload.from)
  const valid = from && !Number.isNaN(from.getTime()) && from.getTime() <= to.getTime()
    && to.getTime() - from.getTime() < SCHEDULE_CATCH_UP_MINUTES * MINUTE
  return { from: valid ? new Date(floorMinute(from.getTime())) : to, to }
}
