import { describe, expect, it } from 'vitest'
import { payloadRange, SCHEDULE_CATCH_UP_MINUTES, scheduledSlot, scheduledSlotsBetween, scheduleRange } from './schedule'
describe('scheduled automation occurrence', () => {
  it('returns a stable minute key only for a due cron occurrence', () => {
    expect(scheduledSlot('0 9 * * *', 'UTC', new Date('2026-10-14T09:00:25Z'))).toBe('2026-10-14T09:00:00.000Z')
    expect(scheduledSlot('0 9 * * *', 'UTC', new Date('2026-10-14T09:01:00Z'))).toBeNull()
  })
  it('honors the configured timezone and fails closed on malformed schedules', () => {
    expect(scheduledSlot('0 9 * * *', 'Asia/Kolkata', new Date('2026-10-14T03:30:45Z'))).toBe('2026-10-14T03:30:00.000Z')
    expect(scheduledSlot('garbage', 'UTC', new Date())).toBeNull()
  })
})

describe('[audit-50/56] catching up missed scheduler minutes', () => {
  const at = (iso: string) => new Date(iso)
  it('lists every occurrence in a range, so a minute the worker missed still fires once', () => {
    expect(scheduledSlotsBetween('0 9 * * *', 'UTC', at('2026-10-14T08:58:00Z'), at('2026-10-14T09:04:30Z')))
      .toEqual(['2026-10-14T09:00:00.000Z'])
    expect(scheduledSlotsBetween('*/2 * * * *', 'UTC', at('2026-10-14T09:00:00Z'), at('2026-10-14T09:05:00Z')))
      .toEqual(['2026-10-14T09:00:00.000Z', '2026-10-14T09:02:00.000Z', '2026-10-14T09:04:00.000Z'])
    expect(scheduledSlotsBetween('0 9 * * *', 'UTC', at('2026-10-14T09:01:00Z'), at('2026-10-14T09:30:00Z'))).toEqual([])
    expect(scheduledSlotsBetween('garbage', 'UTC', at('2026-10-14T09:00:00Z'), at('2026-10-14T09:05:00Z'))).toEqual([])
  })
  it('never reaches back past the catch-up window', () => {
    const slots = scheduledSlotsBetween('* * * * *', 'UTC', at('2026-10-14T00:00:00Z'), at('2026-10-14T09:00:00Z'))
    expect(slots).toHaveLength(SCHEDULE_CATCH_UP_MINUTES)
    expect(slots.at(-1)).toBe('2026-10-14T09:00:00.000Z')
  })
  it('covers the minutes after the last one queued, the current minute alone when nothing was missed', () => {
    const now = Date.parse('2026-10-14T09:04:20Z')
    expect(scheduleRange(at('2026-10-14T08:58:00Z'), now)).toEqual({ from: at('2026-10-14T08:59:00Z'), to: at('2026-10-14T09:04:00Z'), missed: 0 })
    expect(scheduleRange(at('2026-10-14T09:04:00Z'), now)).toEqual({ from: at('2026-10-14T09:04:00Z'), to: at('2026-10-14T09:04:00Z'), missed: 0 })
    expect(scheduleRange(null, now)).toEqual({ from: at('2026-10-14T09:04:00Z'), to: at('2026-10-14T09:04:00Z'), missed: 0 })
    // Down for three hours: the last hour is caught up and the rest is counted as skipped.
    const long = scheduleRange(at('2026-10-14T06:04:00Z'), now)
    expect(long.from).toEqual(at('2026-10-14T08:05:00Z'))
    expect(long.missed).toBe(120)
  })
  it('reads a queued payload range; an old payload is its minute alone and a forged wide range is refused', () => {
    expect(payloadRange({ minute: '2026-10-14T09:04:00.000Z', from: '2026-10-14T08:59:00.000Z' }))
      .toEqual({ from: at('2026-10-14T08:59:00Z'), to: at('2026-10-14T09:04:00Z') })
    expect(payloadRange({ minute: '2026-10-14T09:04:00.000Z' })).toEqual({ from: at('2026-10-14T09:04:00Z'), to: at('2026-10-14T09:04:00Z') })
    expect(payloadRange({ minute: '2026-10-14T09:04:00.000Z', from: '2026-10-13T09:04:00.000Z' }).from).toEqual(at('2026-10-14T09:04:00Z'))
    expect(payloadRange({ minute: '2026-10-14T09:04:00.000Z', from: '2026-10-14T09:05:00.000Z' }).from).toEqual(at('2026-10-14T09:04:00Z'))
  })
})
