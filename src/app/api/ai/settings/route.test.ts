import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
  checkRateLimit: vi.fn(),
  readAiSettings: vi.fn(),
  writeAiSettings: vi.fn(),
  aiConfigured: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit, rateLimitResponse: () => new Response(null, { status: 429 }), RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/ai/settings', async (original) => ({
  ...(await original<typeof import('@/lib/ai/settings')>()),
  readAiSettings: h.readAiSettings, writeAiSettings: h.writeAiSettings, aiConfigured: h.aiConfigured,
}))

import { GET, PUT } from './route'
import { DEFAULT_AI_SETTINGS, parseSettingsPatch } from '@/lib/ai/settings'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' }
const put = (body: unknown) => PUT(new Request('https://crm.test/api/ai/settings', { method: 'PUT', body: JSON.stringify(body) }))

beforeEach(() => {
  delete process.env.AI_ENABLED
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.checkRateLimit.mockReturnValue({ success: true })
  h.readAiSettings.mockResolvedValue({ ...DEFAULT_AI_SETTINGS })
  h.writeAiSettings.mockImplementation(async (_tx: unknown, _c: unknown, patch: object) => ({ ...DEFAULT_AI_SETTINGS, ...patch }))
  h.aiConfigured.mockResolvedValue(false)
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('GET /api/ai/settings', () => {
  it('needs an admin with ai.settings and shows every feature off by default', async () => {
    const response = await GET()
    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(h.requirePermission).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'admin' }, 'ai.settings')
    expect(await response.json()).toEqual({ settings: DEFAULT_AI_SETTINGS, deployment_enabled: true, configured: false })
  })

  it('refuses a member below admin and a restricted admin', async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    expect(h.readAiSettings).not.toHaveBeenCalled()
  })

  it('reports the deployment switch', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    expect((await (await GET()).json()).deployment_enabled).toBe(false)
  })
})

describe('PUT /api/ai/settings', () => {
  it('saves valid switches as the caller', async () => {
    const response = await put({ summaries_enabled: true, monthly_token_cap: 50000 })
    expect(response.status).toBe(200)
    expect(h.writeAiSettings).toHaveBeenCalledWith({}, { accountId: ctx.accountId, userId: ctx.userId }, { summaries_enabled: true, monthly_token_cap: 50000 })
    expect((await response.json()).settings).toMatchObject({ summaries_enabled: true, monthly_token_cap: 50000 })
  })

  it.each([{}, { summaries_enabled: 'yes' }, { monthly_token_cap: 0 }, { monthly_token_cap: 1.5 }, { monthly_token_cap: -3 }, null, []])('rejects %j', async (body) => {
    expect((await put(body)).status).toBe(400)
    expect(h.writeAiSettings).not.toHaveBeenCalled()
  })

  it('needs ai.settings and respects the rate limit', async () => {
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await put({ insights_enabled: true })).status).toBe(403)
    h.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await put({ insights_enabled: true })).status).toBe(429)
    expect(h.writeAiSettings).not.toHaveBeenCalled()
  })
})

describe('parseSettingsPatch', () => {
  it('accepts toggles and a nullable cap, ignores unknown keys', () => {
    expect(parseSettingsPatch({ assessment_enabled: false, monthly_token_cap: null, other: 1 })).toEqual({ assessment_enabled: false, monthly_token_cap: null })
  })
})
