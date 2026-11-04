import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
  checkRateLimit: vi.fn(),
  summarize: vi.fn(),
  replies: vi.fn(),
  availability: vi.fn(),
  reject: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit, rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiAssistUser: { u: 1 }, aiAssistAccount: { a: 1 } },
}))
vi.mock('@/lib/ai/assist/assist', () => ({ summarizeConversation: h.summarize, suggestReplies: h.replies, assistAvailability: h.availability }))
vi.mock('@/lib/ai/assist/suggestions', () => ({ rejectSuggestion: h.reject }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}) }))

import { POST as summary } from './summary/route'
import { POST as replies } from './replies/route'
import { GET as availability } from './availability/route'
import { POST as decision } from './suggestions/[id]/decision/route'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' }
const CONV = '33333333-3333-4333-8333-333333333333'
const SUGG = '44444444-4444-4444-8444-444444444444'
const post = (body: unknown) => new Request('https://crm.test/api/ai/assist', { method: 'POST', body: JSON.stringify(body) })
const forbidden = () => Object.assign(new Error('no'), { status: 403 })

beforeEach(() => {
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.checkRateLimit.mockReturnValue({ success: true })
  h.summarize.mockResolvedValue({ ok: true, suggestionId: SUGG, summary: 's', openQuestions: [], nextSteps: [], dataAsOf: 'x', guardFlags: [], sensitive: [] })
  h.replies.mockResolvedValue({ ok: true, options: [{ suggestionId: SUGG, text: 'Hi' }], citations: [], guardFlags: [], routeToStaff: null })
  h.availability.mockResolvedValue({ summary: { ok: false, reason: 'feature_off' }, suggest: { ok: true, reason: null } })
  h.reject.mockResolvedValue('ok')
})
afterEach(() => vi.clearAllMocks())

describe('assistant routes: access', () => {
  const calls = [
    ['summary', () => summary(post({ conversationId: CONV }))],
    ['replies', () => replies(post({ conversationId: CONV }))],
    ['availability', () => availability()],
    ['decision', () => decision(post({ decision: 'rejected' }), { params: Promise.resolve({ id: SUGG }) })],
  ] as const

  it.each(calls)('%s needs an agent with ai.assist', async (_name, call) => {
    await call()
    expect(h.requireRole).toHaveBeenCalledWith('agent')
    expect(h.requirePermission).toHaveBeenCalledWith(ctx, 'ai.assist')
    h.requireRole.mockRejectedValueOnce(forbidden())
    expect((await call()).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(forbidden())
    expect((await call()).status).toBe(403)
  })

  it.each(calls.slice(0, 2))('%s is rate limited per member and per workspace', async (_name, call) => {
    h.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await call()).status).toBe(429)
    h.checkRateLimit.mockReturnValueOnce({ success: true }).mockReturnValueOnce({ success: false })
    expect((await call()).status).toBe(429)
    expect(h.checkRateLimit).toHaveBeenCalledWith(`ai-assist:${ctx.userId}`, { u: 1 })
    expect(h.checkRateLimit).toHaveBeenCalledWith(`ai-assist-acct:${ctx.accountId}`, { a: 1 })
    expect(h.summarize).not.toHaveBeenCalled()
    expect(h.replies).not.toHaveBeenCalled()
  })
})

describe('POST /api/ai/assist/summary', () => {
  it('summarises as the caller', async () => {
    const res = await summary(post({ conversationId: CONV }))
    expect(res.status).toBe(200)
    expect(h.summarize).toHaveBeenCalledWith(ctx, CONV)
    expect(await res.json()).toMatchObject({ ok: true, suggestionId: SUGG })
  })

  it('rejects a bad id, 404s another workspace\'s conversation and explains fallbacks', async () => {
    expect((await summary(post({ conversationId: 'nope' }))).status).toBe(400)
    h.summarize.mockResolvedValueOnce({ ok: false, reason: 'not_found', guardFlags: [] })
    expect((await summary(post({ conversationId: CONV }))).status).toBe(404)
    h.summarize.mockResolvedValueOnce({ ok: false, reason: 'feature_off', guardFlags: [] })
    const res = await summary(post({ conversationId: CONV }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'feature_off', guard_flags: [] })
  })
})

describe('POST /api/ai/assist/replies', () => {
  it('passes a bounded count and defaults to three', async () => {
    await replies(post({ conversationId: CONV, count: 2 }))
    expect(h.replies).toHaveBeenLastCalledWith(ctx, CONV, 2)
    await replies(post({ conversationId: CONV }))
    expect(h.replies).toHaveBeenLastCalledWith(ctx, CONV, 3)
  })

  it.each([0, 4, 1.5, '2'])('rejects count %j', async (count) => {
    expect((await replies(post({ conversationId: CONV, count }))).status).toBe(400)
  })

  it('400s when the customer has not written', async () => {
    h.replies.mockResolvedValueOnce({ ok: false, reason: 'no_messages', guardFlags: [] })
    expect((await replies(post({ conversationId: CONV }))).status).toBe(400)
  })
})

describe('GET /api/ai/assist/availability', () => {
  it('reports each feature for the caller', async () => {
    expect(await (await availability()).json()).toEqual({ summary: { ok: false, reason: 'feature_off' }, suggest: { ok: true, reason: null } })
    expect(h.availability).toHaveBeenCalledWith(ctx)
  })
})

describe('POST /api/ai/assist/suggestions/:id/decision', () => {
  const call = (id: string, body: unknown) => decision(post(body), { params: Promise.resolve({ id }) })

  it('rejects as the caller', async () => {
    expect((await call(SUGG, { decision: 'rejected' })).status).toBe(200)
    expect(h.reject).toHaveBeenCalledWith({}, { accountId: ctx.accountId, userId: ctx.userId }, SUGG)
  })

  it('accepts only a rejection of a valid id', async () => {
    expect((await call(SUGG, { decision: 'accepted' })).status).toBe(400)
    expect((await call('x', { decision: 'rejected' })).status).toBe(400)
    expect(h.reject).not.toHaveBeenCalled()
  })

  it('404s another workspace\'s suggestion and 409s a decided one', async () => {
    h.reject.mockResolvedValueOnce('not_found')
    expect((await call(SUGG, { decision: 'rejected' })).status).toBe(404)
    h.reject.mockResolvedValueOnce('already_decided')
    expect((await call(SUGG, { decision: 'rejected' })).status).toBe(409)
  })
})
