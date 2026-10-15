import { CronExpressionParser } from 'cron-parser'
/** UTC ISO occurrence keys prevent duplicate dispatch within a scheduled minute. */
export function scheduledSlot(schedule: string, timezone: string, now: Date): string | null {
  try {
    if (schedule.trim().split(/\s+/).length !== 5) return null
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
    const next = CronExpressionParser.parse(schedule, { currentDate: new Date(minute.getTime() - 1), tz: timezone }).next().toDate()
    return next.getTime() === minute.getTime() ? next.toISOString() : null
  } catch { return null }
}
