import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rate: vi.fn(),
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  getAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  duplicateAgent: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.rate,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}))
vi.mock('@/lib/ai/agents', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/agents')>()),
  listAgents: h.listAgents, createAgent: h.createAgent, getAgent: h.getAgent,
  updateAgent: h.updateAgent, deleteAgent: h.deleteAgent, duplicateAgent: h.duplicateAgent,
}))

import { GET as list, POST as create } from './route'
import { DELETE as remove, GET as getOne, PATCH as patch } from './[id]/route'
import { POST as duplicate } from './[id]/duplicate/route'
import { AgentError } from '@/lib/ai/agents'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' }
const tenant = { accountId: ctx.accountId, userId: ctx.userId, role: 'admin' }
const id = '33333333-3333-4333-8333-333333333333'
const params = { params: Promise.resolve({ id }) }
const json = (body: unknown, method = 'POST') => new Request('http://local/api/ai/agents', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const refuse = (status: number) => h.requireRole.mockRejectedValueOnce(Object.assign(new Error('no'), { status }))

beforeEach(() => {
  h.requireRole.mockResolvedValue(ctx)
  h.rate.mockReturnValue({ success: true })
})
afterEach(() => vi.clearAllMocks())

describe('/api/ai/agents', () => {
  it('lists for any member inside the caller tenant, never cached', async () => {
    h.listAgents.mockResolvedValue({ agents: [], profile_saved: false })
    const res = await list()
    expect(res.status).toBe(200)
    expect(h.requireRole).toHaveBeenCalledWith('viewer')
    expect(h.listAgents).toHaveBeenCalledWith(tenant)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('creates only as an admin, after validating the body', async () => {
    h.createAgent.mockResolvedValue({ id })
    const res = await create(json({ name: 'Bookings', instructions: 'Book tables', channels: ['whatsapp'] }))
    expect(res.status).toBe(201)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(h.createAgent).toHaveBeenCalledWith(tenant, expect.objectContaining({ name: 'Bookings' }))

    refuse(403)
    expect((await create(json({ name: 'X', instructions: 'Y' }))).status).toBe(403)
    const bad = await create(json({ name: 'X', instructions: 'Y', account_id: ctx.accountId }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).code).toBe('invalid_input')
    expect(h.createAgent).toHaveBeenCalledTimes(1)
  })

  it('is rate limited before any write', async () => {
    h.rate.mockReturnValueOnce({ success: false })
    expect((await create(json({ name: 'X', instructions: 'Y' }))).status).toBe(429)
    expect(h.createAgent).not.toHaveBeenCalled()
  })

  it('maps agent refusals to stable codes', async () => {
    h.createAgent.mockRejectedValueOnce(new AgentError('limit_reached'))
    const res = await create(json({ name: 'X', instructions: 'Y' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('limit_reached')
  })
})

describe('/api/ai/agents/:id', () => {
  it('answers 404 for an agent the caller cannot see', async () => {
    h.getAgent.mockResolvedValue(null)
    const res = await getOne(new Request('http://local'), params)
    expect(res.status).toBe(404)
    expect(h.getAgent).toHaveBeenCalledWith(tenant, id)
  })

  it('edits and moves as an admin only', async () => {
    h.updateAgent.mockResolvedValue({ id })
    expect((await patch(json({ enabled: true }, 'PATCH'), params)).status).toBe(200)
    expect(h.updateAgent).toHaveBeenCalledWith(tenant, id, { enabled: true })
    expect((await patch(json({ move: 'up' }, 'PATCH'), params)).status).toBe(200)
    expect(h.updateAgent).toHaveBeenLastCalledWith(tenant, id, { move: 'up' })
    expect((await patch(json({ move: 'sideways' }, 'PATCH'), params)).status).toBe(400)
    expect((await patch(json({ is_default: true }, 'PATCH'), params)).status).toBe(400)
    refuse(403)
    expect((await patch(json({ enabled: false }, 'PATCH'), params)).status).toBe(403)
    expect(h.updateAgent).toHaveBeenCalledTimes(2)
  })

  it('refuses to delete the default agent', async () => {
    h.deleteAgent.mockRejectedValueOnce(new AgentError('default_agent'))
    const res = await remove(new Request('http://local', { method: 'DELETE' }), params)
    expect(res.status).toBe(409)
    refuse(403)
    expect((await remove(new Request('http://local', { method: 'DELETE' }), params)).status).toBe(403)
    expect(h.deleteAgent).toHaveBeenCalledTimes(1)
  })

  it('duplicates as an admin only', async () => {
    h.duplicateAgent.mockResolvedValue({ id: 'copy' })
    expect((await duplicate(new Request('http://local', { method: 'POST' }), params)).status).toBe(201)
    expect(h.duplicateAgent).toHaveBeenCalledWith(tenant, id)
    refuse(403)
    expect((await duplicate(new Request('http://local', { method: 'POST' }), params)).status).toBe(403)
  })
})
