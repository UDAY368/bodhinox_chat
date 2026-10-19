import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataClient } from '@/lib/data/types'
import { createInteractiveDelivery } from './interactive-delivery'
import * as meta from './meta-api'
import { providerMediaUrl } from '@/lib/storage/server'

vi.mock('@/lib/storage/server', () => ({ providerMediaUrl: vi.fn(async (_account: string, url: string) => `signed:${url}`) }))
vi.mock('./meta-api', () => ({
  sendInteractiveButtons: vi.fn(async () => ({ messageId: 'prompt' })),
  sendInteractiveList: vi.fn(async () => ({ messageId: 'prompt' })),
  sendLocationMessage: vi.fn(async () => ({ messageId: 'location' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'media' })),
}))
function setup(failInsert = false) {
  const rows: Record<string, unknown>[] = []
  const db = { from: () => ({ insert: async (row: Record<string, unknown>) => {
    rows.push(row); return { error: failInsert ? { message: 'disk failed' } : null }
  } }) } as unknown as DataClient
  return { rows, db, base: { db, accountId: 'account', conversationId: 'conversation', senderType: 'agent' as const, phoneNumberId: 'phone', accessToken: 'token' } }
}
describe('interactive delivery', () => {
  beforeEach(() => vi.clearAllMocks())
  it('signs a private image for native headers without modifying the persisted source payload', async () => {
    const { base } = setup()
    const payload = { kind: 'buttons' as const, body: 'Pick', media: { type: 'image' as const, url: 'private://asset' }, buttons: [{ id: 'original', title: 'Choose' }] }
    await createInteractiveDelivery({ ...base, payload }).send('recipient')
    expect(providerMediaUrl).toHaveBeenCalledWith('account', 'private://asset')
    expect(meta.sendInteractiveButtons).toHaveBeenCalledWith(expect.objectContaining({ media: { type: 'image', url: 'signed:private://asset' }, buttons: payload.buttons }))
    expect(payload.media.url).toBe('private://asset')
    expect(meta.sendMediaMessage).not.toHaveBeenCalled()
  })
  it('persists location with useful coordinates before the prompt and does not repeat it on retry', async () => {
    const { base, rows } = setup()
    vi.mocked(meta.sendInteractiveButtons).mockRejectedValueOnce(new Error('recipient not allowed')).mockResolvedValue({ messageId: 'prompt' })
    const delivery = createInteractiveDelivery({ ...base, payload: { kind: 'buttons', body: 'Pick', media: { type: 'location', latitude: 19.1, longitude: 72.2, name: 'Office', address: 'Mumbai' }, buttons: [{ id: 'a', title: 'Choose' }] } })
    await expect(delivery.send('first')).rejects.toThrow('recipient not allowed')
    await delivery.send('second')
    expect(meta.sendLocationMessage).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([expect.objectContaining({ account_id: 'account', conversation_id: 'conversation', sender_type: 'agent', content_type: 'location', message_id: 'location', content_text: 'Office\nMumbai\n19.1, 72.2' })])
    expect(vi.mocked(meta.sendInteractiveButtons).mock.calls[1][0]).not.toHaveProperty('media')
  })
  it('sends and saves list documents separately, retaining original URLs and filename', async () => {
    const { base, rows } = setup()
    await createInteractiveDelivery({ ...base, senderType: 'bot', payload: { kind: 'list', body: 'Pick', media: { type: 'document', url: 'private://guide', filename: 'guide.pdf' }, button_label: 'Options', sections: [{ rows: [{ id: 'a', title: 'A' }] }] } }).send('recipient')
    expect(meta.sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({ link: 'signed:private://guide', kind: 'document', filename: 'guide.pdf' }))
    expect(rows[0]).toMatchObject({ media_url: 'private://guide', content_text: 'guide.pdf', sender_type: 'bot' })
    expect(meta.sendInteractiveList).toHaveBeenCalledTimes(1)
  })
  it('fails before sending the prompt if the preceding sent message cannot be saved', async () => {
    const { base } = setup(true)
    const delivery = createInteractiveDelivery({ ...base, payload: { kind: 'buttons', body: 'Pick', media: { type: 'location', latitude: 0, longitude: 0 }, buttons: [{ id: 'a', title: 'A' }] } })
    await expect(delivery.send('recipient')).rejects.toThrow(/disk failed/)
    await expect(delivery.send('another recipient')).rejects.toThrow(/disk failed/)
    expect(meta.sendInteractiveButtons).not.toHaveBeenCalled()
  })
})
