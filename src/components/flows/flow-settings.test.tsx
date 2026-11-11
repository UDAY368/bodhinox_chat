import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  editor: {} as Record<string, unknown>,
  numbers: [] as { id: string; display_phone_number: string; is_default: boolean }[],
  fetch: vi.fn(),
}))
vi.mock('./flow-editor-state', () => ({ useFlowEditor: () => h.editor }))
vi.mock('@/components/settings/numbers/use-whatsapp-numbers', () => ({
  useWhatsAppNumbers: () => ({ numbers: h.numbers, loading: false, reload: vi.fn() }),
  numberLabel: (n: { display_phone_number: string }) => n.display_phone_number,
}))
vi.mock('@/lib/auth/client', () => ({ authFetch: h.fetch }))
vi.mock('@/lib/storage/upload-media', () => ({ uploadAccountMedia: vi.fn() }))
vi.mock('./forms/node-config-form', () => ({ FLOW_MEDIA_BUCKET: 'flow-media', MEDIA_ACCEPT: { image: 'image/*', video: 'video/*' } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

import { FlowSettings, parseTestUsernames, persistTriggerNumber } from './flow-settings'

const editor = (triggerNumber: string | null, channelScope = 'whatsapp', status = 'active') => ({
  // The loaded row still says "every number"; the editor holds what was saved since.
  flow: { id: 'flow-1', whatsapp_config_id: null },
  channelScope,
  state: { fallback_policy: { on_unknown_reply: 'reprompt' }, test_numbers: [], test_usernames: ['shop.owner'], status },
  setState: vi.fn(),
  triggerNumber,
  setTriggerNumber: vi.fn(),
})

describe('flow trigger number', () => {
  beforeEach(() => { h.fetch.mockReset() })

  it('reopening Settings shows the number saved in the editor, not the loaded row', () => {
    h.numbers = [{ id: 'num-b', display_phone_number: '+1 555 0102', is_default: true }]
    h.editor = editor('num-b')
    const html = renderToStaticMarkup(<FlowSettings />)
    // One-number workspace: the picker still shows because a number is set.
    expect(html).toContain('id="flow-trigger-number"')
    expect(html).toMatch(/<option value="num-b" selected="">/)
  })

  it('hides the picker in a one-number workspace when the flow listens on every number', () => {
    h.numbers = [{ id: 'num-b', display_phone_number: '+1 555 0102', is_default: true }]
    h.editor = editor(null)
    expect(renderToStaticMarkup(<FlowSettings />)).not.toContain('flow-trigger-number')
  })

  it('keeps the saved number in editor state after a successful save', async () => {
    h.fetch.mockResolvedValue({ ok: true })
    const set = vi.fn()
    expect(await persistTriggerNumber('flow-1', null, 'num-b', set)).toBe(true)
    expect(set.mock.calls).toEqual([['num-b']])
    expect(h.fetch).toHaveBeenCalledWith('/api/flows/flow-1/number', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ whatsapp_config_id: 'num-b' }),
    }))
  })

  it('puts the previous number back when the save is refused or fails', async () => {
    const set = vi.fn()
    h.fetch.mockResolvedValueOnce({ ok: false })
    expect(await persistTriggerNumber('flow-1', 'num-a', 'num-b', set)).toBe(false)
    h.fetch.mockRejectedValueOnce(new Error('offline'))
    expect(await persistTriggerNumber('flow-1', 'num-a', null, set)).toBe(false)
    expect(set.mock.calls).toEqual([['num-b'], ['num-a'], [null], ['num-a']])
  })
})

describe('test usernames (Stage 5)', () => {
  it('reads lowercase usernames without @, de-duplicated, at most three', () => {
    expect(parseTestUsernames('@Shop.Owner, shop.owner  second_one\nthird, fourth')).toEqual({
      list: ['shop.owner', 'second_one', 'third'], invalid: [], tooMany: true,
    })
    expect(parseTestUsernames('good, not-valid!, @')).toEqual({ list: ['good'], invalid: ['not-valid!'], tooMany: false })
  })

  it('an Instagram draft shows test usernames in place of test numbers', () => {
    h.numbers = []
    h.editor = editor(null, 'instagram', 'draft')
    const html = renderToStaticMarkup(<FlowSettings />)
    expect(html).toContain('id="test-usernames"')
    expect(html).toContain('value="shop.owner"')
    expect(html).not.toContain('id="test-numbers"')
  })

  it('a WhatsApp draft keeps its test numbers', () => {
    h.numbers = []
    h.editor = editor(null, 'whatsapp', 'draft')
    const html = renderToStaticMarkup(<FlowSettings />)
    expect(html).toContain('id="test-numbers"')
    expect(html).not.toContain('id="test-usernames"')
  })
})
