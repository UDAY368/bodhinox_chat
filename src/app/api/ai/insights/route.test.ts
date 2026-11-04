import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  role: 'agent', restricted: false, limited: false,
  requestInsight: vi.fn(), listInsightRuns: vi.fn(), getInsightRun: vi.fn(), insightsEnabled: vi.fn(),
}))

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }))
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null })
      return b
    },
  }),
}))
vi.mock('@/lib/auth/permissions', async () => {
  const { ForbiddenError } = await import('@/lib/auth/errors')
  return { requirePermission: async () => { if (h.restricted) throw new ForbiddenError('This feature is turned off for your role') } }
})
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { aiAssistUser: { limit: 20, windowMs: 60_000 }, aiAssistAccount: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}))
vi.mock('@/lib/ai/insights/runs', async (original) => ({
  ...(await original<typeof import('@/lib/ai/insights/runs')>()),
  requestInsight: h.requestInsight, listInsightRuns: h.listInsightRuns, getInsightRun: h.getInsightRun, insightsEnabled: h.insightsEnabled,
}))

import { InsightError } from '@/lib/ai/insights/runs'
import { GET, POST } from './route'
import { GET as GET_ONE } from './[id]/route'

const actor = { accountId: ACCOUNT, userId: USER, role: 'agent' }
const post = (body: unknown) => new Request('http://localhost/api/ai/insights', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
})
const params = { params: Promise.resolve({ id: RUN }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.role = 'agent'
  h.restricted = false
  h.limited = false
  h.insightsEnabled.mockResolvedValue(true)
  h.listInsightRuns.mockResolvedValue([{ id: RUN }])
  h.requestInsight.mockResolvedValue({ id: RUN, status: 'queued' })
  h.getInsightRun.mockResolvedValue({ id: RUN, status: 'done' })
})

describe('/api/ai/insights', () => {
  it('lists the switch, the allowed keys and runs for an agent', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ enabled: true, runs: [{ id: RUN }] })
    expect(body.keys).toHaveLength(8)
    expect(h.listInsightRuns).toHaveBeenCalledWith(actor)
  })

  it('refuses viewers and roles restricted from ai.insights', async () => {
    h.role = 'viewer'
    expect((await GET()).status).toBe(403)
    expect((await POST(post({ key: 'conversation_volume' }))).status).toBe(403)
    h.role = 'agent'
    h.restricted = true
    expect((await GET()).status).toBe(403)
    expect((await POST(post({ key: 'conversation_volume' }))).status).toBe(403)
    expect((await GET_ONE(new Request('http://localhost'), params)).status).toBe(403)
    expect(h.requestInsight).not.toHaveBeenCalled()
  })

  it('queues a run and answers 202 with only the fixed key and range fields', async () => {
    const res = await POST(post({ key: 'campaign_funnel', preset: '30d', sql: 'DROP TABLE x' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ run: { id: RUN, status: 'queued' } })
    expect(h.requestInsight).toHaveBeenCalledWith(actor, { key: 'campaign_funnel', range: { preset: '30d', from: null, to: null } })
  })

  it('passes a malformed body on as a missing key', async () => {
    h.requestInsight.mockRejectedValue(new InsightError('invalid_key'))
    const res = await POST(post('not json'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_key')
    expect(h.requestInsight).toHaveBeenCalledWith(actor, { key: undefined, range: { preset: null, from: null, to: null } })
  })

  it.each([
    ['feature_off', 409], ['too_many_pending', 429], ['invalid_range', 400], ['forbidden', 403],
  ] as const)('maps %s to %i', async (code, status) => {
    h.requestInsight.mockRejectedValue(new InsightError(code))
    const res = await POST(post({ key: 'conversation_volume' }))
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })

  it('rate limits requests', async () => {
    h.limited = true
    expect((await POST(post({ key: 'conversation_volume' }))).status).toBe(429)
    expect(h.requestInsight).not.toHaveBeenCalled()
  })

  it('reads one run, and answers 404 for a run the caller cannot see (another member or workspace)', async () => {
    const res = await GET_ONE(new Request('http://localhost'), params)
    expect(res.status).toBe(200)
    expect(h.getInsightRun).toHaveBeenCalledWith(actor, RUN)
    h.getInsightRun.mockRejectedValue(new InsightError('not_found'))
    expect((await GET_ONE(new Request('http://localhost'), params)).status).toBe(404)
  })

  it('hides unexpected errors', async () => {
    h.listInsightRuns.mockRejectedValue(new Error('relation "ai_insight_runs" secret detail'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    err.mockRestore()
  })
})
