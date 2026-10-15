import { describe, expect, it } from 'vitest'
import { scheduledSlot } from './schedule'
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
