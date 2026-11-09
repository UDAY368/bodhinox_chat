import { beforeEach, describe, expect, it, vi } from 'vitest'
import { engineSendInteractiveButtons, engineSendText } from './meta-send'
import { engineSendInteractive } from '@/lib/automations/meta-send'
import { sendInteractiveButtons, sendMediaMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], active: true,
  numbers: null as Record<string, unknown>[] | null, conversationNumber: null as string | null,
  insertError: null as { message: string } | null }))
vi.mock('@/lib/whatsapp/bot-pause', () => ({ assertBotRepliesEnabled: vi.fn(async () => {}) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))
vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn(async (_account: string, url: string) => `signed:${url}`) }))
vi.mock('@/lib/whatsapp/meta-api', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'prompt' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'prompt' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'media' })),
  sendTextMessage: vi.fn(async () => ({ messageId: 'text' })),
}))
vi.mock('./admin-client', () => ({ databaseAdmin: () => ({ from: (table: string) => {
  const filters: Record<string, unknown> = {}
  let inserting = false
  const data = table === 'contacts' ? { id: 'contact', phone: '+15551234567' } : table === 'whatsapp_config' ? (h.numbers ?? { phone_number_id: 'phone', access_token: 'token' }) : table === 'flows' ? { id: 'flow', status: h.active ? 'active' : 'draft' } : { id: 'conversation', whatsapp_config_id: h.conversationNumber }
  const one = () => table === 'whatsapp_config' && h.numbers ? h.numbers.find((n) => n.id === filters.id) ?? null : data
  const builder = { select: () => builder, eq: (field: string, value: unknown) => { filters[field] = value; return builder }, update: () => builder,
    insert: (row: Record<string, unknown>) => { h.rows.push(row); inserting = true; return builder },
    maybeSingle: async () => ({ data: one(), error: null }), single: async () => ({ data: one(), error: null }),
    then: (resolve: (value: unknown) => unknown) => resolve({ data, error: inserting ? h.insertError : null }),
  }; return builder
} }) }))
describe('engine interactive delivery', () => {
  const base = { accountId: 'account', userId: 'user', conversationId: 'conversation', contactId: 'contact' }
  beforeEach(() => { h.rows = []; h.active = true; h.numbers = null; h.conversationNumber = null; h.insertError = null; vi.clearAllMocks() })
  it('rechecks AI ownership immediately before the external text send', async () => {
    await expect(engineSendText({ ...base, text: 'Reply', beforeSend: async () => { throw new Error('Human takeover') } })).rejects.toThrow('Human takeover')
    expect(sendTextMessage).not.toHaveBeenCalled()
  })
  it('reports a text as sent before saving it, so a failed save is not mistaken for an undelivered reply', async () => {
    h.insertError = { message: 'insert refused' }
    const onSent = vi.fn()
    await expect(engineSendText({ ...base, text: 'Reply', onSent })).rejects.toThrow()
    expect(sendTextMessage).toHaveBeenCalledTimes(1)
    expect(onSent).toHaveBeenCalledTimes(1)
  })
  it('does not report a text as sent when the ownership check refuses', async () => {
    const onSent = vi.fn()
    await expect(engineSendText({ ...base, text: 'Reply', onSent, beforeSend: async () => { throw new Error('Human takeover') } })).rejects.toThrow()
    expect(onSent).not.toHaveBeenCalled()
  })
  it('binds workflow actions once and saves the same IDs and original media delivered by a bot', async () => {
    await engineSendInteractiveButtons({ ...base, bodyText: 'Pick', media: { type: 'image', url: 'https://cdn.test/image' }, buttons: [{ id: 'old', title: 'Start', action: { type: 'flow', targetId: '11111111-1111-4111-8111-111111111111' } }] })
    const args = vi.mocked(sendInteractiveButtons).mock.calls[0][0]
    expect(args.media).toEqual({ type: 'image', url: 'signed:https://cdn.test/image' })
    expect(args.buttons[0].id).toMatch(/^qr_/)
    expect(h.rows[0]).toMatchObject({ sender_type: 'bot', interactive_payload: { media: { url: 'https://cdn.test/image' }, buttons: args.buttons } })
  })
  it('retains flow edge IDs when no workflow action is configured', async () => {
    await engineSendInteractiveButtons({ ...base, bodyText: 'Pick', buttons: [{ id: 'edge-id', title: 'Next' }] })
    expect(vi.mocked(sendInteractiveButtons).mock.calls[0][0].buttons[0].id).toBe('edge-id')
  })
  it('rejects inactive targets before sending', async () => {
    h.active = false
    await expect(engineSendInteractiveButtons({ ...base, bodyText: 'Pick', buttons: [{ id: 'old', title: 'Start', action: { type: 'flow', targetId: '11111111-1111-4111-8111-111111111111' } }] })).rejects.toThrow(/inactive/)
    expect(sendInteractiveButtons).not.toHaveBeenCalled()
  })
  it('preserves document metadata through automation delegation to list delivery', async () => {
    await engineSendInteractive({ ...base, payload: { kind: 'list', body: 'Choose', media: { type: 'document', url: 'https://cdn.test/doc', filename: 'menu.pdf' }, button_label: 'Menu', sections: [{ rows: [{ id: 'a', title: 'A' }] }] } })
    expect(sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({ link: 'signed:https://cdn.test/doc', filename: 'menu.pdf' }))
    expect(h.rows[0]).toMatchObject({ account_id: 'account', conversation_id: 'conversation', sender_type: 'bot', media_url: 'https://cdn.test/doc' })
    expect(h.rows[1]).toMatchObject({ interactive_payload: { media: { type: 'document', url: 'https://cdn.test/doc', filename: 'menu.pdf' } } })
  })
  describe('two numbers in one workspace', () => {
    const A = '11111111-1111-4111-8111-11111111111a'
    const B = '22222222-2222-4222-8222-22222222222b'
    const numbers = [
      { id: B, phone_number_id: 'pn-second', access_token: 'token', is_default: false, created_at: '2026-02-01T00:00:00Z' },
      { id: A, phone_number_id: 'pn-default', access_token: 'token', is_default: true, created_at: '2026-01-01T00:00:00Z' },
    ]
    it("sends a flow step from the conversation's number", async () => {
      h.numbers = numbers; h.conversationNumber = B
      await engineSendText({ ...base, text: 'Hi' })
      expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-second' }))
    })
    it('sends interactive steps from the conversation number too', async () => {
      h.numbers = numbers; h.conversationNumber = B
      await engineSendInteractiveButtons({ ...base, bodyText: 'Pick', buttons: [{ id: 'edge-id', title: 'Next' }] })
      expect(sendInteractiveButtons).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-second' }))
    })
    it('uses the default number for a legacy conversation without one', async () => {
      h.numbers = numbers; h.conversationNumber = null
      await engineSendText({ ...base, text: 'Hi' })
      expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-default' }))
    })
  })
})
