import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  checkRateLimit: vi.fn(),
  validateAiCredentials: vi.fn(),
  existing: null as Record<string, unknown> | null,
  stored: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: (error: Error) => new Response(error.message, { status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: mocks.validateAiCredentials }))

import { GET, POST } from './route'

beforeEach(() => {
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.existing, error: null }) }) }),
      insert: async (row: Record<string, unknown>) => {
        mocks.stored = row
        return { error: null }
      },
    }),
  }
  mocks.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: 'admin-1' })
  mocks.getCurrentAccount.mockResolvedValue({ db, accountId: 'account-1' })
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.validateAiCredentials.mockResolvedValue(undefined)
  mocks.existing = null
  mocks.stored = null
  vi.stubEnv('GEMINI_API_KEY', 'server-only-test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('Gemini settings', () => {
  it('validates with the server key and saves no key in the account row', async () => {
    const response = await POST(new Request('https://crm.test/api/ai/config', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.8-flash', is_active: true }),
    }))
    expect(response.status).toBe(200)
    expect(mocks.validateAiCredentials).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'gemini', apiKey: 'server-only-test-key',
    }))
    expect(mocks.stored).toMatchObject({ provider: 'gemini', api_key: null })
    expect(JSON.stringify(mocks.stored)).not.toContain('server-only-test-key')
  })

  it('rejects a browser-submitted Gemini key', async () => {
    const response = await POST(new Request('https://crm.test/api/ai/config', {
      method: 'POST',
      body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.8-flash', api_key: 'unsafe-browser-key' }),
    }))
    expect(response.status).toBe(400)
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled()
  })

  it('reports key availability without returning the server key', async () => {
    mocks.existing = {
      provider: 'gemini', model: 'gemini-3.8-flash', api_key: null,
      embeddings_api_key: null, is_active: true,
    }
    const response = await GET()
    const body = await response.json()
    expect(body.has_key).toBe(true)
    expect(body.api_key).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('server-only-test-key')
  })
})
