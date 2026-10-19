import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadAiConfig: vi.fn(),
  retrieveKnowledge: vi.fn(),
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
vi.mock('@/lib/ai/knowledge', () => ({ retrieveKnowledge: mocks.retrieveKnowledge }))

import { POST } from './route'

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({ db: {}, accountId: 'account-1', userId: 'agent-1' })
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'gemini', model: 'gemini-3.8-flash', apiKey: 'test-key', baseUrl: null,
    systemPrompt: 'We sell coffee.', isActive: false, autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
  })
  mocks.retrieveKnowledge.mockResolvedValue(['Our opening hours are 9am to 5pm.'])
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
})
