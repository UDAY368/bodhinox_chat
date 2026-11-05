import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledgeScored: vi.fn(),
  generateReply: vi.fn(),
  loadAgentProfile: vi.fn(),
  reserveAi: vi.fn(),
  settleAi: vi.fn(),
  health: false,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: Error & { status?: number }) => new Response(error.message, { status: error.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: mocks.requirePermission }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/context', () => ({ buildConversationContext: mocks.buildConversationContext }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledgeScored: mocks.retrieveKnowledgeScored }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/budget', () => ({ reserveAi: mocks.reserveAi, settleAi: mocks.settleAi, failAi: async () => {}, chatTokenEstimate: () => 10 }))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({ $queryRaw: async () => [{ has: mocks.health }] }),
}))
vi.mock('@/lib/ai/agent-profile', async (original) => ({
  ...(await original<typeof import('@/lib/ai/agent-profile')>()),
  loadAgentProfile: mocks.loadAgentProfile,
}))

import { POST } from './route'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { DEFAULT_HANDOFF_RULES, emptyAgentProfile } from '@/lib/ai/agent-profile'
import { ForbiddenError } from '@/lib/auth/errors'

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
const citation = { chunk_id: 'ch-1', document_id: 'doc-1', source_id: null, title: 'Delivery', source_url: 'https://beans.example/delivery' }

beforeEach(() => {
  delete process.env.AI_ENABLED
  mocks.health = false
  mocks.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: 'agent-1', role: 'agent' })
  mocks.requirePermission.mockResolvedValue(undefined)
  mocks.reserveAi.mockReset().mockResolvedValue({ reservation: true })
  mocks.settleAi.mockReset().mockResolvedValue(undefined)
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', baseUrl: null, systemPrompt: 'We sell coffee.',
    isActive: true, autoReplyEnabled: false, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
  })
  mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Do you deliver?' }])
  mocks.retrieveKnowledgeScored.mockResolvedValue({
    chunks: [{ id: 'ch-1', content: 'Delivery inside Bangalore only.', document_id: 'doc-1', source_id: null, title: 'Delivery', source_url: citation.source_url }],
    retrieval: { lexicalRanks: [1] }, citations: [citation],
  })
  mocks.generateReply.mockResolvedValue({ text: 'Yes, inside Bangalore.', handoff: false, usage: null })
  mocks.loadAgentProfile.mockResolvedValue(null)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('POST /api/ai/draft', () => {
  it('drafts with the agent profile: business name and instructions, never the no-answer phrase', async () => {
    mocks.loadAgentProfile.mockResolvedValue({
      ...emptyAgentProfile(), business_name: 'Bean There', instructions: 'Only discuss our Bangalore store; prices in INR.',
      handoff_rules: { ...DEFAULT_HANDOFF_RULES },
    })
    const response = await draft()
    expect(await response.json()).toEqual({ draft: 'Yes, inside Bangalore.', citations: [citation] })
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

  it('holds one AI message per request before the call and settles it once with the usage log', async () => {
    const response = await draft()
    expect(response.status).toBe(200)
    expect(mocks.reserveAi).toHaveBeenCalledWith('account-1', expect.stringMatching(/^req:[0-9a-f-]{36}$/), { message: true, tokens: 10 })
    expect(mocks.settleAi).toHaveBeenCalledWith({ reservation: true }, expect.objectContaining({ log: expect.objectContaining({ mode: 'draft', conversationId: 'conv-1' }) }))
  })

  it('refuses with 402 before any provider call when the plan has no AI messages left', async () => {
    const { PlanLimitError } = await import('@/lib/billing/entitlements')
    mocks.reserveAi.mockRejectedValueOnce(new PlanLimitError('The Free plan allows up to 100 AI replies this month. Upgrade for more.'))
    expect((await draft()).status).toBe(402)
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('retrieves customer-facing knowledge only', async () => {
    await draft()
    expect(mocks.retrieveKnowledgeScored).toHaveBeenCalledWith(db, 'account-1', expect.anything(), 'Do you deliver?', 5, 'customer')
  })

  it('needs the ai.assist permission (a restricted role loses drafts)', async () => {
    mocks.requirePermission.mockRejectedValueOnce(new ForbiddenError('This feature is turned off for your role'))
    expect((await draft()).status).toBe(403)
    expect(mocks.requirePermission).toHaveBeenCalledWith({ accountId: 'account-1', userId: 'agent-1', role: 'agent' }, 'ai.assist')
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('makes no provider call when the deployment kill switch is off', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    const response = await draft()
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('ai_disabled')
    expect(mocks.generateReply).not.toHaveBeenCalled()
    expect(mocks.retrieveKnowledgeScored).not.toHaveBeenCalled()
  })

  it('routes a health question to staff without drafting', async () => {
    mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'My child has a fever, what dose of paracetamol?' }])
    const response = await draft()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ draft: null, code: 'route_to_staff' })
    expect(body.categories).toContain('treatment_or_dosage')
    expect(mocks.generateReply).not.toHaveBeenCalled()
    expect(mocks.reserveAi).not.toHaveBeenCalled()
  })

  it('routes a burst to staff: a health question followed by a neutral message', async () => {
    mocks.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'My child has a fever, what dose of paracetamol?' },
      { role: 'user', content: 'hello??' },
    ])
    const body = await (await draft()).json()
    expect(body).toMatchObject({ draft: null, code: 'route_to_staff' })
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it.each([
    'Your payment has been received and confirmed.',
    'Great news, your order has been shipped.',
    'This sounds like an infection. Take 500 mg of amoxicillin twice a day.',
  ])('withholds a draft that asserts a status or gives medical advice: %s', async (text) => {
    mocks.generateReply.mockResolvedValue({ text, handoff: false, usage: null })
    const response = await draft()
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ draft: null, code: 'guard_blocked' })
  })

  it('allows conditional status wording', async () => {
    mocks.generateReply.mockResolvedValue({ text: 'Once your payment is confirmed, we will ship within 2 days.', handoff: false, usage: null })
    expect(await (await draft()).json()).toMatchObject({ draft: 'Once your payment is confirmed, we will ship within 2 days.' })
  })

  it('withholds an unreadable script for a health-type workspace only', async () => {
    mocks.generateReply.mockResolvedValue({ text: 'మీ అపాయింట్మెంట్ రేపు ఉంది', handoff: false, usage: null })
    expect((await draft()).status).toBe(200)
    mocks.health = true
    expect((await draft()).status).toBe(422)
  })

  it('strips links that are not cited or the business website', async () => {
    mocks.generateReply.mockResolvedValue({ text: 'See https://beans.example/delivery or https://exfil.example.net/c?d=1', handoff: false, usage: null })
    const { draft: text } = await (await draft()).json()
    expect(text).toContain('https://beans.example/delivery')
    expect(text).not.toContain('exfil')
  })

  it('masks personal data before the provider call and logs no customer text', async () => {
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'error')]
    mocks.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'Do you deliver? Call me on +919876543210, mail asha@example.com' }])
    await draft()
    const sent = JSON.stringify(mocks.generateReply.mock.calls[0][0].messages)
    expect(sent).not.toContain('9876543210')
    expect(sent).not.toContain('asha@example.com')
    const logged = JSON.stringify(logs.flatMap((s) => s.mock.calls))
    expect(logged).not.toContain('asha')
    expect(logged).not.toContain('deliver')
  })
})
