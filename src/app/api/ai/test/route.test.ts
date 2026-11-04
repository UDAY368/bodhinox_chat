import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn(), validateAiCredentials: vi.fn() }))
vi.mock('@/lib/auth/account', () => ({ requireRole: h.requireRole, toErrorResponse: () => new Response(null, { status: 403 }) }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: vi.fn(), RATE_LIMITS: { adminAction: {} } }))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: h.validateAiCredentials }))

import { POST } from './route'

const post = () => POST(new Request('https://crm.test/api/ai/test', { method: 'POST', body: JSON.stringify({ provider: 'openai', model: 'gpt-x', api_key: 'sk-test' }) }))

beforeEach(() => {
  h.requireRole.mockResolvedValue({ db: {}, accountId: 'account-1', userId: 'admin-1' })
  h.validateAiCredentials.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('tests the key with the provider when the kill switch is unset', async () => {
  delete process.env.AI_ENABLED
  expect((await post()).status).toBe(200)
  expect(h.validateAiCredentials).toHaveBeenCalledTimes(1)
})

it('answers 503 ai_disabled without a provider round-trip when AI_ENABLED=false', async () => {
  vi.stubEnv('AI_ENABLED', 'false')
  const response = await post()
  expect(response.status).toBe(503)
  expect((await response.json()).code).toBe('ai_disabled')
  expect(h.validateAiCredentials).not.toHaveBeenCalled()
})
