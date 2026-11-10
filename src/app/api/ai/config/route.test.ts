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
import { encrypt } from '@/lib/whatsapp/encryption'

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

it('requires a fresh key when changing a compatible provider endpoint', async () => {
  mocks.existing = { id: 'config-1', provider: 'openai_compatible', model: 'old-model', base_url: 'https://example.com/v1', api_key: encrypt('stored-other-provider-key') }
  const response = await POST(new Request('https://crm.test/api/ai/config', { method: 'POST', body: JSON.stringify({ provider: 'openai_compatible', model: 'openrouter/free', base_url: 'https://openrouter.ai/api/v1' }) }))
  expect(response.status).toBe(400)
  expect((await response.json()).code).toBe('reenter_key')
  expect(mocks.validateAiCredentials).not.toHaveBeenCalled()
})

it('encrypts an OpenRouter key without exposing it in settings responses', async () => {
  const response = await POST(new Request('https://crm.test/api/ai/config', { method: 'POST', body: JSON.stringify({ provider: 'openai_compatible', model: 'openrouter/free', base_url: 'https://openrouter.ai/api/v1', api_key: 'test-openrouter-key' }) }))
  expect(response.status).toBe(200)
  expect(mocks.stored?.api_key).toBeTruthy()
  expect(JSON.stringify(mocks.stored)).not.toContain('test-openrouter-key')
  mocks.existing = mocks.stored
  expect(JSON.stringify(await (await GET()).json())).not.toContain('test-openrouter-key')
})

describe('deployment kill switch (phase 13)', () => {
  it('refuses to verify or save a key while AI_ENABLED=false, before any probe', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    const response = await POST(new Request('https://crm.test/api/ai/config', { method: 'POST', body: JSON.stringify({ provider: 'openai', model: 'gpt-x', api_key: 'sk-new' }) }))
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('ai_disabled')
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled()
    expect(mocks.stored).toBeNull()
  })

  it('still lets an admin save a change that needs no verification (turning AI off)', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    mocks.existing = { id: 'config-1', provider: 'openai', model: 'gpt-x', base_url: null, api_key: encrypt('stored-key') }
    const update = vi.fn(() => ({ eq: async () => ({ error: null }) }))
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.existing, error: null }) }) }), update }) }
    mocks.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: 'admin-1' })
    const response = await POST(new Request('https://crm.test/api/ai/config', { method: 'POST', body: JSON.stringify({ provider: 'openai', model: 'gpt-x', is_active: false }) }))
    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }))
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled()
  })
})

describe('the Instagram auto-reply switch (Stage 2)', () => {
  const existingDb = () => {
    mocks.existing = { id: 'config-1', provider: 'openai', model: 'gpt-x', base_url: null, api_key: encrypt('stored-key') }
    const update = vi.fn<(row: Record<string, unknown>) => { eq: () => Promise<{ error: null }> }>(() => ({ eq: async () => ({ error: null }) }))
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.existing, error: null }) }) }), update }) }
    mocks.requireRole.mockResolvedValue({ db, accountId: 'account-1', userId: 'admin-1' })
    return update
  }
  const post = (body: Record<string, unknown>) => POST(new Request('https://crm.test/api/ai/config', {
    method: 'POST', body: JSON.stringify({ provider: 'openai', model: 'gpt-x', ...body }),
  }))

  it('saves the Instagram switch apart from the WhatsApp one', async () => {
    const update = existingDb()
    expect((await post({ auto_reply_enabled: false, instagram_auto_reply_enabled: true })).status).toBe(200)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ auto_reply_enabled: false, instagram_auto_reply_enabled: true }))
  })

  it('leaves it unchanged when an older client does not send it', async () => {
    const update = existingDb()
    expect((await post({ auto_reply_enabled: true })).status).toBe(200)
    expect(update.mock.calls[0][0]).not.toHaveProperty('instagram_auto_reply_enabled')
  })

  it('refuses a value that is not a boolean, writing nothing', async () => {
    const update = existingDb()
    expect((await post({ instagram_auto_reply_enabled: 'yes' })).status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('returns the switch to members reading the config, never the key', async () => {
    mocks.existing = { provider: 'openai', model: 'gpt-x', api_key: 'enc', embeddings_api_key: null, is_active: true,
      auto_reply_enabled: false, instagram_auto_reply_enabled: true }
    const body = await (await GET()).json()
    expect(body).toMatchObject({ auto_reply_enabled: false, instagram_auto_reply_enabled: true })
    expect(body.api_key).toBeUndefined()
  })

  it('stays admin-only: a refused role writes nothing', async () => {
    const update = existingDb()
    mocks.requireRole.mockRejectedValueOnce(new Error('Forbidden'))
    expect((await post({ instagram_auto_reply_enabled: true })).status).toBe(500)
    expect(mocks.requireRole).toHaveBeenCalledWith('admin')
    expect(update).not.toHaveBeenCalled()
  })
})
