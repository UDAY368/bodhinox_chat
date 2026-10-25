import { describe, expect, it } from 'vitest'
import { flowRunDuration } from './run-duration'

describe('flow run duration', () => {
  it('shows elapsed execution time, regardless of how long ago the run ended', () => {
    expect(flowRunDuration('2026-10-25T06:26:24Z', '2026-10-25T06:27:06Z')).toBe('42 seconds')
  })
  it.each([null, 'invalid', '2026-10-25T06:26:00Z'])('omits unfinished or invalid intervals: %s', ended => {
    expect(flowRunDuration('2026-10-25T06:26:24Z', ended)).toBeNull()
  })
})
