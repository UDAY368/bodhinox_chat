import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(), requirePermission: vi.fn(), readAiSettings: vi.fn(),
  conversationExists: vi.fn(), readCurrentAssessment: vi.fn(), tenants: [] as unknown[],
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (c: unknown, fn: (tx: unknown) => unknown) => { h.tenants.push(c); return fn({}) } }))
vi.mock('@/lib/ai/settings', () => ({ readAiSettings: h.readAiSettings }))
vi.mock('@/lib/ai/assess/repo', () => ({ conversationExists: h.conversationExists, readCurrentAssessment: h.readCurrentAssessment }))

import { GET } from './route'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' }
const CONV = '33333333-3333-4333-8333-333333333333'
const get = (id = CONV) => GET(new Request(`https://crm.test/api/ai/assess/conversation/${id}`), { params: Promise.resolve({ id }) })
const row = { id: 'a1', intent: 'pricing', lead_score: 40 }

beforeEach(() => {
  h.tenants.length = 0
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.readAiSettings.mockResolvedValue({ assessment_enabled: true })
  h.conversationExists.mockResolvedValue(true)
  h.readCurrentAssessment.mockResolvedValue(row)
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/ai/assess/conversation/:id', () => {
  it('returns the current assessment for an agent with ai.assist, in the member tenant', async () => {
    const response = await get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: true, assessment: row })
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(h.requirePermission).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'agent' }, 'ai.assist')
    expect(h.tenants).toEqual([{ accountId: ctx.accountId, userId: ctx.userId, role: 'agent' }])
    expect(h.readCurrentAssessment).toHaveBeenCalledWith({}, ctx.accountId, CONV)
  })

  it('refuses viewers and members restricted from ai.assist', async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }))
    expect((await get()).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await get()).status).toBe(403)
    expect(h.readCurrentAssessment).not.toHaveBeenCalled()
  })

  it('is 404 for another workspace\'s conversation and for a malformed id', async () => {
    h.conversationExists.mockResolvedValueOnce(false)
    expect((await get()).status).toBe(404)
    expect((await get('nope')).status).toBe(404)
    expect(h.readCurrentAssessment).not.toHaveBeenCalled()
  })

  it('reports the workspace switch and an empty state', async () => {
    h.readAiSettings.mockResolvedValue({ assessment_enabled: false })
    h.readCurrentAssessment.mockResolvedValue(null)
    expect(await (await get()).json()).toEqual({ enabled: false, assessment: null })
  })
})
