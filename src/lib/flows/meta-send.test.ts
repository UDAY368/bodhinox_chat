import { beforeEach, describe, expect, it, vi } from 'vitest'
import { engineSendInteractiveButtons, engineSendText } from './meta-send'
import { engineSendInteractive } from '@/lib/automations/meta-send'
import { sendInteractiveButtons, sendMediaMessage, sendTextMessage } from '@/lib/whatsapp/meta-api'

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], active: true }))
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
  const data = table === 'contacts' ? { id: 'contact', phone: '+15551234567' } : table === 'whatsapp_config' ? { phone_number_id: 'phone', access_token: 'token' } : table === 'flows' ? { id: 'flow', status: h.active ? 'active' : 'draft' } : { id: 'conversation' }
  const builder = { select: () => builder, eq: () => builder, update: () => builder,
    insert: (row: Record<string, unknown>) => { h.rows.push(row); return builder },
    maybeSingle: async () => ({ data, error: null }), single: async () => ({ data, error: null }),
    then: (resolve: (value: unknown) => unknown) => resolve({ data, error: null }),
  }; return builder
} }) }))
describe('engine interactive delivery', () => {
  const base = { accountId: 'account', userId: 'user', conversationId: 'conversation', contactId: 'contact' }
  beforeEach(() => { h.rows = []; h.active = true; vi.clearAllMocks() })
  it('rechecks AI ownership immediately before the external text send', async () => {
    await expect(engineSendText({ ...base, text: 'Reply', beforeSend: async () => { throw new Error('Human takeover') } })).rejects.toThrow('Human takeover')
    expect(sendTextMessage).not.toHaveBeenCalled()
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
})

