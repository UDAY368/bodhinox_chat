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

describe('palette capability block', () => {
  it('blocks a provider-gated node only once the workspace is known to lack it', async () => {
    const { paletteBlock, CAPABILITY_SETUP_HREF } = await import('./palette')
    expect(paletteBlock('payment_link', null)).toBeNull()
    expect(paletteBlock('payment_link', { payments: false })).toBe('payments')
    expect(paletteBlock('payment_link', { payments: true })).toBeNull()
    expect(paletteBlock('send_message', { payments: false })).toBeNull()
    expect(CAPABILITY_SETUP_HREF.payments).toMatch(/^\//)
  })
})
