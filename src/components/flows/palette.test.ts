import { describe, expect, it } from 'vitest'
import { filterPaletteTypes } from './palette'

describe('flow block search', () => {
  const items = [
    { type: 'send_message', label: 'Send message', description: 'Plain text reply' },
    { type: 'collect_input', label: 'Collect input', description: 'Capture an email or phone number' },
  ] as const
  it('matches a localized label or description without case sensitivity', () => {
    expect(filterPaletteTypes(items, ' EMAIL ').map(i => i.type)).toEqual(['collect_input'])
    expect(filterPaletteTypes(items, 'message').map(i => i.type)).toEqual(['send_message'])
  })
  it('keeps original order for an empty search and returns no unrelated blocks', () => {
    expect(filterPaletteTypes(items, '')).toEqual(items)
    expect(filterPaletteTypes(items, 'unavailable')).toEqual([])
  })
})
