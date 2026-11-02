import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSession: vi.fn(),
  assertMutation: vi.fn(),
  checkRateLimit: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  logAiUsage: vi.fn(),
  databaseAdmin: vi.fn(),
  requireAiMessageRoom: vi.fn(),
  recordAiMessage: vi.fn(),
}))

class FakeAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: unknown) =>
    error instanceof FakeAuthError
      ? Response.json({ error: error.message }, { status: error.status })
      : new Response('error', { status: 500 }),
}))
vi.mock('@/lib/auth/session', () => ({
  requireSession: mocks.requireSession,
  assertMutation: mocks.assertMutation,
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }))
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: mocks.databaseAdmin }))
vi.mock('@/lib/billing/limits', () => ({ requireAiMessageRoom: mocks.requireAiMessageRoom, recordAiMessage: mocks.recordAiMessage }))

import { POST } from './route'

const VALID = {
  name: 'booking_reminder',
  body_text: 'Hi {{1}}, see you at {{2}} tomorrow.',
  sample_values: { body: ['Ana', '10:00'] },
}
const usage = { promptTokens: 5, completionTokens: 7, totalTokens: 12 }

function post(body: unknown) {
  return POST(
    new Request('https://crm.test/api/whatsapp/templates/ai-draft', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  )
}
const BRIEF = { goal: 'Remind about tomorrow’s booking', tone: 'professional', category: 'Utility', language: 'en_US' }

beforeEach(() => {
  mocks.requireRole.mockResolvedValue({ db: { tag: 'db' }, accountId: 'account-1', userId: 'admin-1' })
  mocks.requireSession.mockResolvedValue({ sessionId: 's1' })
  mocks.assertMutation.mockResolvedValue(undefined)
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadAiConfig.mockResolvedValue({
    provider: 'openai', model: 'gpt-test', apiKey: 'secret-key', baseUrl: null, systemPrompt: null,
    isActive: true, autoReplyEnabled: false, autoReplyMaxPerConversation: 3, handoffAgentId: null,
    embeddingsApiKey: null,
  })
  mocks.databaseAdmin.mockReturnValue({ tag: 'admin' })
  mocks.logAiUsage.mockResolvedValue(undefined)
})

afterEach(() => vi.clearAllMocks())

describe('POST /api/whatsapp/templates/ai-draft', () => {
  it('requires the admin role that can submit templates', async () => {
    mocks.requireRole.mockRejectedValue(new FakeAuthError('Insufficient workspace role', 403))
    const res = await post(BRIEF)
    expect(res.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('refuses a request without Origin/CSRF proof', async () => {
    mocks.assertMutation.mockRejectedValue(new FakeAuthError('Unauthorized', 401))
    expect((await post(BRIEF)).status).toBe(401)
    expect(mocks.loadAiConfig).not.toHaveBeenCalled()
  })

  it('rate-limits before calling the provider', async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await post(BRIEF)).status).toBe(429)
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('rejects an invalid brief', async () => {
    const res = await post({ ...BRIEF, tone: 'angry' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('toneInvalid')
  })

  it('refuses with the plan error when the monthly AI messages are used up', async () => {
    mocks.requireAiMessageRoom.mockRejectedValueOnce(new FakeAuthError('The Free plan allows up to 100 AI replies this month. Upgrade for more.', 402))
    const res = await post(BRIEF)
    expect(res.status).toBe(402)
    expect((await res.json()).error).toMatch(/Upgrade/)
    expect(mocks.requireAiMessageRoom).toHaveBeenCalledWith('account-1')
    expect(mocks.generateReply).not.toHaveBeenCalled()
    expect(mocks.recordAiMessage).not.toHaveBeenCalled()
  })

  it('returns 409 when AI is not configured', async () => {
    mocks.loadAiConfig.mockResolvedValue(null)
    const res = await post(BRIEF)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ai_not_configured')
  })

  it('returns a validated draft and logs usage without content', async () => {
    mocks.generateReply.mockResolvedValue({ text: JSON.stringify(VALID), handoff: false, usage })
    const res = await post(BRIEF)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.draft).toMatchObject({
      name: 'booking_reminder',
      category: 'Utility',
      language: 'en_US',
      sample_values: { body: ['Ana', '10:00'] },
    })
    expect(JSON.stringify(data)).not.toContain('secret-key')
    expect(mocks.loadAiConfig).toHaveBeenCalledWith({ tag: 'db' }, 'account-1')
    expect(mocks.logAiUsage).toHaveBeenCalledTimes(1)
    expect(mocks.logAiUsage).toHaveBeenCalledWith({ tag: 'admin' }, {
      accountId: 'account-1', conversationId: null, mode: 'draft', provider: 'openai',
      model: 'gpt-test', usage,
    })
  })

  it('returns 422 when the draft is invalid twice, logging both calls', async () => {
    mocks.generateReply.mockResolvedValue({
      text: JSON.stringify({ ...VALID, sample_values: { body: [] } }),
      handoff: false,
      usage,
    })
    const res = await post(BRIEF)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('draft_invalid')
    expect(mocks.generateReply).toHaveBeenCalledTimes(2)
    expect(mocks.logAiUsage).toHaveBeenCalledTimes(2)
  })
})
