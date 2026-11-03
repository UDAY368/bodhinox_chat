import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadAiConfig: vi.fn(),
  retrieveKnowledgeScored: vi.fn(),
  loadAgentProfile: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: Error) => new Response(error.message, { status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiDraft: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledgeScored: mocks.retrieveKnowledgeScored }))
vi.mock('@/lib/ai/agent-profile', async (original) => ({
  ...(await original<typeof import('@/lib/ai/agent-profile')>()),
  loadAgentProfile: mocks.loadAgentProfile,
}))
vi.mock('@/lib/billing/limits', () => ({ requireAiMessageRoom: async () => {}, recordAiMessage: async () => {} }))

import { POST } from './route'

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({ db: {}, accountId: 'account-1', userId: 'agent-1', role: 'agent' })
  mocks.loadAgentProfile.mockResolvedValue(null)
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'test-key', baseUrl: null,
    systemPrompt: 'We sell coffee.', isActive: false, autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
  })
  mocks.retrieveKnowledgeScored.mockResolvedValue({
    chunks: [{ id: 'c1', content: 'Our opening hours are 9am to 5pm.', document_id: 'd1', title: 'Hours', source_url: null }],
    retrieval: { lexicalRanks: [0.1] },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Gemini agent playground workflow', () => {
  it('uses account context, knowledge, Gemini, and returns the agent reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'We are open from 9am to 5pm.' }] } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(new Request('https://crm.test/api/ai/playground', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'When are you open?' }] }),
    }))

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toMatchObject({ reply: 'We are open from 9am to 5pm.', handoff: false,
      diagnostics: { model: 'gemini-3.8-flash', knowledgeMatches: 1, retrievalMs: expect.any(Number), generationMs: expect.any(Number), totalMs: expect.any(Number) } })
    expect(data.diagnostics.totalMs).toBeGreaterThanOrEqual(data.diagnostics.generationMs)
    expect(JSON.stringify(data)).not.toContain('test-key')
    expect(mocks.loadAiConfig).toHaveBeenCalledWith({}, 'account-1', { requireActive: false })
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(payload.systemInstruction.parts[0].text).toContain('Our opening hours are 9am to 5pm.')
    expect(payload.contents[0].parts[0].text).toBe('When are you open?')
  })

  const gemini = (text: string) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const ask = (messages: Array<{ role: string; content: string }>) => POST(new Request('https://crm.test/api/ai/playground', {
    method: 'POST', body: JSON.stringify({ messages }),
  }))
  const profile = (over: Record<string, unknown> = {}, rules: Record<string, unknown> = {}) => ({
    business_name: 'Bean There', business_type: null, website_url: null, instructions: 'Only discuss our Bangalore store; prices in INR.',
    greeting: null, tone: null, setup_completed_at: null, updated_at: null,
    handoff_rules: { keywords: [], on_low_confidence: true, confidence_threshold: 0.35, max_turns_before_handoff: 0, ...rules }, ...over,
  })

  it('tests with the agent profile prompt the live agent uses, and the no-answer handoff', async () => {
    mocks.loadAgentProfile.mockResolvedValue(profile())
    const fetchMock = gemini('[[NO_ANSWER]]')
    const response = await ask([{ role: 'user', content: 'Do you sell tea in Delhi?' }])
    const data = await response.json()
    expect(mocks.loadAgentProfile).toHaveBeenCalledWith({ accountId: 'account-1', userId: 'agent-1', role: 'agent' })
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).systemInstruction.parts[0].text as string
    expect(prompt).toContain('Bean There')
    expect(prompt).toContain('Only discuss our Bangalore store; prices in INR.')
    expect(prompt).not.toContain('We sell coffee.')
    expect(prompt).toContain('[[NO_ANSWER]]')
    expect(data).toMatchObject({ reply: '', handoff: true, reason: 'no_answer', score: 0 })
  })

  it('hands off on a profile keyword or the turn limit without calling the model', async () => {
    const fetchMock = gemini('unused')
    mocks.loadAgentProfile.mockResolvedValue(profile({}, { keywords: ['refund'] }))
    expect(await (await ask([{ role: 'user', content: 'I want a refund' }])).json()).toMatchObject({ handoff: true, reason: 'handoff_keyword', reply: '' })
    mocks.loadAgentProfile.mockResolvedValue(profile({}, { max_turns_before_handoff: 1 }))
    expect(await (await ask([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello!' }, { role: 'user', content: 'and?' }])).json())
      .toMatchObject({ handoff: true, reason: 'max_turns' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a workspace without a profile on its legacy prompt and sends a weakly supported answer', async () => {
    const fetchMock = gemini('We are open from 9am to 5pm.')
    const data = await (await ask([{ role: 'user', content: 'When are you open?' }])).json()
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).systemInstruction.parts[0].text as string
    expect(prompt).toContain('We sell coffee.')
    expect(prompt).not.toContain('[[NO_ANSWER]]')
    expect(data).toMatchObject({ reply: 'We are open from 9am to 5pm.', handoff: false, reason: 'answered' })
  })
})
