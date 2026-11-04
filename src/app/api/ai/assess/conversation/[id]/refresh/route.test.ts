import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(), requirePermission: vi.fn(), checkRateLimit: vi.fn(), readAiSettings: vi.fn(),
  conversationExists: vi.fn(), queueAssessmentRefresh: vi.fn(), tenants: [] as unknown[],
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (c: unknown, fn: (tx: unknown) => unknown) => { h.tenants.push(c); return fn({}) } }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit, rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiAssistUser: { limit: 20 }, aiAssistAccount: { limit: 60 } },
}))
vi.mock('@/lib/ai/settings', () => ({ readAiSettings: h.readAiSettings }))
vi.mock('@/lib/ai/assess/repo', () => ({ conversationExists: h.conversationExists, queueAssessmentRefresh: h.queueAssessmentRefresh }))

import { POST } from './route'
import { setAiTransportForTests } from '@/lib/ai/generate'
import { createFakeTransport, fakeCalls, resetFakeCalls } from '@/lib/ai/providers/fake'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' }
const CONV = '33333333-3333-4333-8333-333333333333'
const post = (id = CONV) => POST(new Request(`https://crm.test/api/ai/assess/conversation/${id}/refresh`, { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  h.tenants.length = 0
  resetFakeCalls()
  setAiTransportForTests(createFakeTransport())
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.checkRateLimit.mockReturnValue({ success: true })
  h.readAiSettings.mockResolvedValue({ assessment_enabled: true })
  h.conversationExists.mockResolvedValue(true)
  h.queueAssessmentRefresh.mockResolvedValue('queued')
})
afterEach(() => { vi.clearAllMocks(); setAiTransportForTests(null) })

describe('POST /api/ai/assess/conversation/:id/refresh', () => {
  it('queues a job in the member tenant and acknowledges 202 without calling a provider', async () => {
    const response = await post()
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'queued' })
    expect(h.requirePermission).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'agent' }, 'ai.assess')
    expect(h.queueAssessmentRefresh).toHaveBeenCalledWith({}, ctx.accountId, CONV)
    expect(h.tenants).toEqual([{ accountId: ctx.accountId, userId: ctx.userId, role: 'agent' }])
    expect(fakeCalls()).toHaveLength(0)
  })

  it('reports a refresh already queued in this slot', async () => {
    h.queueAssessmentRefresh.mockResolvedValue('already_queued')
    expect(await (await post()).json()).toEqual({ status: 'already_queued' })
  })

  it('refuses viewers and members restricted from ai.assess', async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }))
    expect((await post()).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await post()).status).toBe(403)
    expect(h.queueAssessmentRefresh).not.toHaveBeenCalled()
  })

  it('is 409 feature_off while the workspace has assessments off', async () => {
    h.readAiSettings.mockResolvedValue({ assessment_enabled: false })
    const response = await post()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'feature_off' })
    expect(h.queueAssessmentRefresh).not.toHaveBeenCalled()
  })

  it('is 404 for another workspace\'s conversation or a malformed id', async () => {
    h.conversationExists.mockResolvedValueOnce(false)
    expect((await post()).status).toBe(404)
    expect((await post('x')).status).toBe(404)
    expect(h.queueAssessmentRefresh).not.toHaveBeenCalled()
  })

  it('applies the per-user and per-workspace rate limits', async () => {
    h.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await post()).status).toBe(429)
    h.checkRateLimit.mockReturnValueOnce({ success: true }).mockReturnValueOnce({ success: false })
    expect((await post()).status).toBe(429)
    expect(h.checkRateLimit).toHaveBeenCalledWith(`ai-assist-user:${ctx.userId}`, { limit: 20 })
    expect(h.checkRateLimit).toHaveBeenCalledWith(`ai-assist-account:${ctx.accountId}`, { limit: 60 })
    expect(h.queueAssessmentRefresh).not.toHaveBeenCalled()
  })
})
