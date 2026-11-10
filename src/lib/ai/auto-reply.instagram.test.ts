// Stage 2: the inbox AI auto-reply on an Instagram conversation. Its own
// switch (off by default) decides, never the WhatsApp one; the account and
// the 24-hour window are checked before any model call; the reply goes
// through the Instagram sender, never the WhatsApp one; refusals are skips
// with a reason code, and nothing logged carries customer content.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from './types'
import { InstagramError } from '@/lib/instagram/errors'

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  conversationNumberDisconnected: vi.fn(),
  sendTypingIndicator: vi.fn(),
  recordReplyEvent: vi.fn(),
  ready: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  conv: null as Record<string, unknown> | null,
  rpcCalls: [] as string[],
  updates: [] as Record<string, unknown>[],
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: async () => [{ role: 'user', content: 'Where is my order 4411?' }] }))
vi.mock('./knowledge', () => ({ retrieveKnowledgeScored: async () => ({ chunks: [], retrieval: null }) }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./reply-events', () => ({ recordReplyEvent: h.recordReplyEvent }))
vi.mock('./budget', () => ({ reserveAi: async () => ({}), settleAi: async () => {}, failAi: async () => {}, chatTokenEstimate: () => 1 }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: vi.fn(),
  conversationNumberDisconnected: h.conversationNumberDisconnected,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({ sendTypingIndicator: h.sendTypingIndicator }))
vi.mock('./instagram-send', () => ({
  assertInstagramAiReady: h.ready,
  prepareInstagramAiReply: h.prepare,
  sendInstagramAiReply: h.send,
  instagramRefusalCode: (error: unknown) => (error instanceof InstagramError ? error.code : null),
}))
vi.mock('./admin-client', () => ({
  databaseAdmin: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, is: () => chain, gt: () => chain,
        update: (value: Record<string, unknown>) => { h.updates.push(value); return chain },
        maybeSingle: async () => ({
          data: table === 'messages' ? { message_id: 'mid.in-1' } : h.conv ? { ...h.conv } : null,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      })
      return chain
    },
    rpc: async (name: string) => { h.rpcCalls.push(name); return { data: true, error: null } },
  }),
}))

import { dispatchInboundToAiReply, recordUnreadableInbound } from './auto-reply'

const ARGS = { accountId: 'acct-1', conversationId: 'conv-1', contactId: 'contact-1', configOwnerUserId: 'user-1', inboundMessageId: 'mid.in-1', routingChecked: true }
const config = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  provider: 'openai', model: 'm', baseUrl: null, apiKey: 'k', systemPrompt: null, isActive: true,
  autoReplyEnabled: true, instagramAutoReplyEnabled: true, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
  ...overrides,
})
const reasons = () => h.recordReplyEvent.mock.calls.map(([event]) => `${event.outcome}:${event.reason}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.rpcCalls = []
  h.updates = []
  h.conv = {
    channel: 'instagram', assigned_agent_id: null, bot_paused: false, ai_autoreply_disabled: false, ai_reply_count: 0,
    last_customer_message_at: new Date().toISOString(),
  }
  h.loadAiConfig.mockResolvedValue(config())
  h.generateReply.mockResolvedValue({ text: 'It ships tomorrow.', handoff: false })
  h.ready.mockResolvedValue(undefined)
  h.prepare.mockImplementation(async (_a: string, _c: string, text: string) => ({ text }))
  h.send.mockImplementation(async (_prepared: unknown, options: { onSent?: () => void }) => { options.onSent?.(); return { whatsapp_message_id: 'mid.out-1' } })
})

describe('the Instagram auto-reply', () => {
  it('answers through the Instagram sender, never the WhatsApp one, with no typing indicator', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.ready).toHaveBeenCalledWith('acct-1', 'conv-1')
    expect(h.prepare).toHaveBeenCalledWith('acct-1', 'conv-1', 'It ships tomorrow.')
    expect(h.send).toHaveBeenCalledWith({ text: 'It ships tomorrow.' }, expect.objectContaining({ beforeSend: expect.any(Function) }))
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.conversationNumberDisconnected).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(reasons()).toEqual(['replied:answered'])
  })

  it('follows the Instagram switch, not the WhatsApp one (off by default)', async () => {
    h.loadAiConfig.mockResolvedValue(config({ instagramAutoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    h.loadAiConfig.mockResolvedValue(config({ instagramAutoReplyEnabled: undefined }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves a WhatsApp thread alone when only the Instagram switch is on', async () => {
    h.conv = { ...h.conv, channel: 'whatsapp' }
    h.loadAiConfig.mockResolvedValue(config({ autoReplyEnabled: false, instagramAutoReplyEnabled: true }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
  })

  it('skips a thread past its 24-hour window before any model call, with a reason code only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    h.conv = { ...h.conv, last_customer_message_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.send).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('[ai auto-reply] skipped', { reason: 'instagram_window_closed' })
    info.mockRestore()
  })

  it.each([
    ['instagram_window_closed', 'skipped:stale'],
    ['instagram_account_disconnected', 'skipped:number_disconnected'],
    ['instagram_token_invalid', 'skipped:number_disconnected'],
  ] as const)('skips with a reason when the Instagram check refuses (%s), before the model', async (code, reason) => {
    h.ready.mockRejectedValueOnce(new InstagramError(code))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.rpcCalls).toEqual([])
    expect(h.send).not.toHaveBeenCalled()
    expect(reasons()).toEqual([reason])
  })

  it('withholds an answer over the Instagram text limit and hands the thread to a person', async () => {
    h.prepare.mockRejectedValueOnce(new InstagramError('invalid_request'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.send).not.toHaveBeenCalled()
    expect(reasons()).toEqual(['handed_off:guard_blocked'])
    expect(h.updates.some((update) => update.bot_paused === true || update.ai_autoreply_disabled === true)).toBe(true)
  })

  it('never logs customer text or the reply', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    h.prepare.mockRejectedValueOnce(new InstagramError('instagram_window_closed'))
    await dispatchInboundToAiReply(ARGS)
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
    expect(logged).not.toContain('4411')
    expect(logged).not.toContain('ships tomorrow')
    for (const spy of spies) spy.mockRestore()
  })
})

describe('recordUnreadableInbound on Instagram', () => {
  it('records the media skip only when the Instagram switch is on', async () => {
    h.loadAiConfig.mockResolvedValue(config({ instagramAutoReplyEnabled: false }))
    await recordUnreadableInbound(ARGS)
    expect(h.recordReplyEvent).not.toHaveBeenCalled()
    h.loadAiConfig.mockResolvedValue(config())
    await recordUnreadableInbound(ARGS)
    expect(reasons()).toEqual(['skipped:media_only'])
  })
})
