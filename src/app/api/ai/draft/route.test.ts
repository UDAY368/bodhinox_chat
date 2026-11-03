import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  loadAgentProfile: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: Error) => new Response(error.message, { status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/context', () => ({ buildConversationContext: mocks.buildConversationContext }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: mocks.retrieveKnowledge }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: async () => {} }))
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: () => ({}) }))
vi.mock('@/lib/billing/limits', () => ({ requireAiMessageRoom: async () => {}, recordAiMessage: async () => {} }))
vi.mock('@/lib/ai/agent-profile', async (original) => ({
  ...(await original<typeof import('@/lib/ai/agent-profile')>()),
  loadAgentProfile: mocks.loadAgentProfile,
}))

import { POST } from './route'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { DEFAULT_HANDOFF_RULES, emptyAgentProfile } from '@/lib/ai/agent-profile'

const db = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { id: 'conv-1' }, error: null }) }
    return chain
  },
}

const draft = () => POST(new Request('https://crm.test/api/ai/draft', {
  method: 'POST', body: JSON.stringify({ conversation_id: 'conv-1' }),
}))
const prompt = () => String(mocks.generateReply.mock.calls[0][0].systemPrompt)

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: 'agent-1', role: 'agent' })
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', baseUrl: null, systemPrompt: 'We sell coffee.',
    isActive: true, autoReplyEnabled: false, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
  })
  mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Do you deliver?' }])
  mocks.retrieveKnowledge.mockResolvedValue(['Delivery inside Bangalore only.'])
  mocks.generateReply.mockResolvedValue({ text: 'Yes, inside Bangalore.', handoff: false, usage: null })
  mocks.loadAgentProfile.mockResolvedValue(null)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ai/draft', () => {
  it('drafts with the agent profile: business name and instructions, never the no-answer phrase', async () => {
    mocks.loadAgentProfile.mockResolvedValue({
      ...emptyAgentProfile(), business_name: 'Bean There', instructions: 'Only discuss our Bangalore store; prices in INR.',
      handoff_rules: { ...DEFAULT_HANDOFF_RULES },
    })
    const response = await draft()
    expect(await response.json()).toEqual({ draft: 'Yes, inside Bangalore.' })
    expect(mocks.loadAgentProfile).toHaveBeenCalledWith({ accountId: 'account-1', userId: 'agent-1', role: 'agent' })
    expect(prompt()).toContain('Bean There')
    expect(prompt()).toContain('Only discuss our Bangalore store; prices in INR.')
    expect(prompt()).toContain('Delivery inside Bangalore only.')
    expect(prompt()).not.toContain('[[NO_ANSWER]]')
  })

  it('keeps the exact legacy prompt when no profile was saved or it cannot be read', async () => {
    const legacy = buildSystemPrompt({ userPrompt: 'We sell coffee.', mode: 'draft', knowledge: ['Delivery inside Bangalore only.'] })
    await draft()
    expect(prompt()).toBe(legacy)
    mocks.generateReply.mockClear()
    mocks.loadAgentProfile.mockRejectedValue(new Error('db down'))
    expect((await draft()).status).toBe(200)
    expect(prompt()).toBe(legacy)
  })
})
