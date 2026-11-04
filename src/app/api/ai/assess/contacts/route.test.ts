import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(), requirePermission: vi.fn(), readAiSettings: vi.fn(), readContactAssessments: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}) }))
vi.mock('@/lib/ai/settings', () => ({ readAiSettings: h.readAiSettings }))
vi.mock('@/lib/ai/assess/repo', () => ({ readContactAssessments: h.readContactAssessments }))

import { GET } from './route'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' }
const uuid = (i: number) => `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`
const get = (ids: string) => GET(new Request(`https://crm.test/api/ai/assess/contacts?ids=${ids}`))

beforeEach(() => {
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.readAiSettings.mockResolvedValue({ assessment_enabled: true })
  h.readContactAssessments.mockResolvedValue([{
    id: 'a', contact_id: uuid(1), conversation_id: 'c', intent: 'purchase', intent_confidence: 80, lead_score: 72,
    qualification: { route_to_staff: false, flags: ['pii_redacted'] }, rationale: 'staff only text', source: 'model', created_at: '2026-11-04T00:00:00.000Z',
  }])
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/ai/assess/contacts', () => {
  it('returns scores keyed by contact, without rationale or flags', async () => {
    const response = await get(`${uuid(1)},${uuid(2)},${uuid(1).toUpperCase()}`)
    expect(response.status).toBe(200)
    expect(h.readContactAssessments).toHaveBeenCalledWith({}, ctx.accountId, [uuid(1), uuid(2)])
    expect(await response.json()).toEqual({
      enabled: true,
      assessments: { [uuid(1)]: {
        conversation_id: 'c', intent: 'purchase', intent_confidence: 80, lead_score: 72, source: 'model',
        route_to_staff: false, created_at: '2026-11-04T00:00:00.000Z',
      } },
    })
    expect(h.requirePermission).toHaveBeenCalledWith(expect.objectContaining({ accountId: ctx.accountId }), 'ai.assist')
  })

  it('rejects malformed ids and more than 100', async () => {
    expect((await get(`${uuid(1)},drop table`)).status).toBe(400)
    expect((await get(Array.from({ length: 101 }, (_, i) => uuid(i)).join(','))).status).toBe(400)
    expect(h.readContactAssessments).not.toHaveBeenCalled()
  })

  it('refuses viewers and restricted members', async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }))
    expect((await get(uuid(1))).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await get(uuid(1))).status).toBe(403)
  })
})
