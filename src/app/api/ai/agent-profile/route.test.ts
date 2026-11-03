import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  loadAgentProfile: vi.fn(),
  saveAgentProfile: vi.fn(),
  rate: { success: true },
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  getCurrentAccount: h.getCurrentAccount,
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => h.rate,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/ai/agent-profile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/agent-profile')>()),
  loadAgentProfile: h.loadAgentProfile,
  saveAgentProfile: h.saveAgentProfile,
}))

import { GET, PUT } from './route'
import { AgentProfileError } from '@/lib/ai/agent-profile'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' }
const put = (body: unknown) => PUT(new Request('https://crm.test/api/ai/agent-profile', { method: 'PUT', body: JSON.stringify(body) }))
const forbidden = () => Object.assign(new Error('Insufficient workspace role'), { status: 403 })

beforeEach(() => {
  vi.clearAllMocks()
  h.rate = { success: true }
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: 'viewer', db: {} })
  h.requireRole.mockResolvedValue({ ...ctx, role: 'admin', db: {} })
})

it('GET returns defaults with saved=false for an unsaved workspace, for any member', async () => {
  h.loadAgentProfile.mockResolvedValue(null)
  const res = await GET()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.saved).toBe(false)
  expect(body.profile.handoff_rules).toMatchObject({ keywords: [], on_low_confidence: true })
  expect(h.loadAgentProfile).toHaveBeenCalledWith({ ...ctx, role: 'viewer' })
})

it('PUT requires admin and passes the caller tenancy to the save', async () => {
  h.saveAgentProfile.mockResolvedValue({ business_name: 'Acme' })
  const res = await put({ business_name: 'Acme', complete_setup: true })
  expect(res.status).toBe(200)
  expect(h.requireRole).toHaveBeenCalledWith('admin')
  expect(h.saveAgentProfile).toHaveBeenCalledWith({ ...ctx, role: 'admin' }, { business_name: 'Acme', complete_setup: true })
})

it('PUT refuses a non-admin before saving', async () => {
  h.requireRole.mockRejectedValue(forbidden())
  expect((await put({ business_name: 'Acme' })).status).toBe(403)
  expect(h.saveAgentProfile).not.toHaveBeenCalled()
})

it('PUT maps validation errors to 400 and rejects non-object bodies', async () => {
  h.saveAgentProfile.mockRejectedValue(new AgentProfileError('Enter a valid website address'))
  const res = await put({ website_url: 'nope' })
  expect(res.status).toBe(400)
  expect((await res.json()).error).toBe('Enter a valid website address')
  expect((await put([1, 2])).status).toBe(400)
})

it('PUT is rate limited', async () => {
  h.rate = { success: false }
  expect((await put({})).status).toBe(429)
  expect(h.saveAgentProfile).not.toHaveBeenCalled()
})
