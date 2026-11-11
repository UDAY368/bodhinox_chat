// Stage 2: the flow AI step on an Instagram conversation. It is no longer
// refused: the reply goes out through the Instagram sender under the same
// outbound intent, the account and window are checked before any model call
// and again before the intent is claimed, and refusals are unavailable
// reasons the run can route on (never a WhatsApp send).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiConfig } from './types'
import { InstagramError } from '@/lib/instagram/errors'

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  rpc: vi.fn(),
  loadAiConfig: vi.fn(),
  generateOpenAi: vi.fn(),
  engineSendText: vi.fn(),
  conversationNumberDisconnected: vi.fn(),
  dispatchOnce: vi.fn(),
  ready: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
}))

vi.mock('./admin-client', async () => {
  const { createFakeDb } = await import('@/lib/flows/fake-db.test-helper')
  return { databaseAdmin: () => ({ ...createFakeDb(h.tables), rpc: h.rpc }) }
})
vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: async () => [{ role: 'user', content: 'Do you ship to Lisbon?' }] }))
vi.mock('./providers/openai', () => ({ generateOpenAi: h.generateOpenAi }))
vi.mock('./unanswered', () => ({ recordUnanswered: vi.fn() }))
vi.mock('./agent-profile', async (original) => ({
  ...(await original<typeof import('./agent-profile')>()),
  loadAgentProfileTx: async () => null,
}))
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => [] }) }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('./budget', () => ({ reserveAi: async () => ({}), settleAi: async () => {}, failAi: async () => {}, chatTokenEstimate: () => 1 }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText, conversationNumberDisconnected: h.conversationNumberDisconnected }))
vi.mock('@/lib/jobs/dispatch', () => ({ dispatchOnce: h.dispatchOnce }))
vi.mock('./instagram-send', () => ({
  assertInstagramAiReady: h.ready,
  prepareInstagramAiReply: h.prepare,
  sendInstagramAiReply: h.send,
  instagramRefusalCode: (error: unknown) => (error instanceof InstagramError ? error.code : null),
}))

import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { runFlowAiReply, type RunFlowAiReplyArgs } from './flow-reply'

const ACCOUNT = 'acct-1'
const config: AiConfig = {
  provider: 'openai', model: 'm', baseUrl: null, apiKey: 'k', systemPrompt: null, isActive: true,
  autoReplyEnabled: false, instagramAutoReplyEnabled: false, autoReplyMaxPerConversation: 5, handoffAgentId: null, embeddingsApiKey: null,
}
const args: RunFlowAiReplyArgs = {
  accountId: ACCOUNT, userId: 'u-1', conversationId: 'cv-1', contactId: 'ct-1', intentKey: 'flow:run-1:ask_ai:0:0',
  config: { use_knowledge: false, next_node_key: 'done', handoff_next: 'human' },
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetRateLimitForTests()
  h.tables = {
    conversations: [{ id: 'cv-1', account_id: ACCOUNT, contact_id: 'ct-1', channel: 'instagram', bot_paused: false,
      ai_autoreply_disabled: false, ai_reply_count: 0, last_customer_message_at: new Date().toISOString() }],
    ai_usage_log: [],
  }
  h.loadAiConfig.mockResolvedValue(config)
  h.generateOpenAi.mockResolvedValue({ text: 'Yes, in 3 days.', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  h.rpc.mockResolvedValue({ data: true, error: null })
  h.dispatchOnce.mockImplementation(async (_account: string, _key: string, send: () => Promise<unknown>) => send())
  h.ready.mockResolvedValue(undefined)
  h.prepare.mockImplementation(async (_a: string, _c: string, text: string) => ({ text }))
  h.send.mockResolvedValue({ whatsapp_message_id: 'mid.ai' })
})

describe('runFlowAiReply on Instagram', () => {
  it('answers through the Instagram sender under the step intent, never the WhatsApp sender', async () => {
    // The inbox switch does not gate a flow step (the flow author placed it).
    const outcome = await runFlowAiReply(args)
    expect(outcome).toMatchObject({ kind: 'answered', text: 'Yes, in 3 days.', whatsappMessageId: 'mid.ai' })
    expect(h.prepare).toHaveBeenCalledWith(ACCOUNT, 'cv-1', 'Yes, in 3 days.')
    expect(h.send).toHaveBeenCalledWith({ text: 'Yes, in 3 days.' }, { beforeSend: expect.any(Function) })
    expect(h.dispatchOnce).toHaveBeenCalledWith(ACCOUNT, 'flow:run-1:ask_ai:0:0', expect.any(Function))
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.conversationNumberDisconnected).not.toHaveBeenCalled()
  })

  it.each([
    ['instagram_window_closed', 'session_closed'],
    ['instagram_account_disconnected', 'number_disconnected'],
    ['instagram_permission_missing', 'number_disconnected'],
  ] as const)('stops before the model when the account or window refuses (%s)', async (code, reason) => {
    h.ready.mockRejectedValueOnce(new InstagramError(code))
    expect(await runFlowAiReply(args)).toEqual({ kind: 'unavailable', reason })
    expect(h.generateOpenAi).not.toHaveBeenCalled()
  })

  it('refuses before claiming the send intent when the answer cannot go, so nothing is left uncertain', async () => {
    h.prepare.mockRejectedValueOnce(new InstagramError('instagram_window_closed'))
    expect(await runFlowAiReply(args)).toEqual({ kind: 'unavailable', reason: 'session_closed' })
    h.prepare.mockRejectedValueOnce(new InstagramError('invalid_request'))
    expect(await runFlowAiReply({ ...args, intentKey: 'flow:run-2:ask_ai:0:0' })).toEqual({ kind: 'unavailable', reason: 'send_failed' })
    expect(h.dispatchOnce.mock.calls.map((call) => call[1])).not.toContain('flow:run-1:ask_ai:0:0')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('still refuses a conversation on an unknown channel', async () => {
    h.tables.conversations[0].channel = 'sms'
    expect(await runFlowAiReply(args)).toEqual({ kind: 'unavailable', reason: 'conversation_unavailable' })
  })
})
