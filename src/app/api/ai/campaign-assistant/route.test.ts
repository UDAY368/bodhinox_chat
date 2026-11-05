import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  requestMeter: vi.fn(),
  beforeAttempt: vi.fn(),
  afterAttempt: vi.fn(),
  finish: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: Error & { status?: number }) => new Response(JSON.stringify({ error: error.message }), { status: error.status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { aiDraft: {}, aiDraftAccount: {} },
}))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig: mocks.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: mocks.generateReply }))
vi.mock('@/lib/ai/budget', () => ({
  ROUTE_GENERATION_TOKENS: 20_000,
  requestMeter: (...args: unknown[]) => {
    mocks.requestMeter(...args)
    return { hooks: { beforeAttempt: mocks.beforeAttempt, afterAttempt: mocks.afterAttempt }, finish: mocks.finish }
  },
}))

import { POST } from './route'

const TAG = '11111111-1111-4111-8111-111111111111'
const template = { id: 'tpl-1', name: 'sale', language: 'en_US', category: 'Marketing', body_text: 'Hi {{1}}', status: 'APPROVED' }

function fakeDb(templates: unknown[] = [template]) {
  const touched: string[] = []
  const result = (data: unknown) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['eq', 'is', 'order', 'select']) chain[m] = () => chain
    chain.limit = async () => ({ data, error: null })
    chain.maybeSingle = async () => ({ data: (data as unknown[])[0] ?? null, error: null })
    return chain
  }
  const db = {
    from(table: string) {
      touched.push(table)
      const data = table === 'message_templates' ? templates : table === 'tags' ? [{ id: TAG, name: 'VIP' }] : []
      return { select: () => result(data), insert: () => { throw new Error(`unexpected insert into ${table}`) } }
    },
  }
  return { db, touched }
}

const req = (body: unknown) => new Request('https://crm.test/api/ai/campaign-assistant', { method: 'POST', body: JSON.stringify(body) })
let db: ReturnType<typeof fakeDb>

beforeEach(() => {
  db = fakeDb()
  mocks.requireRole.mockResolvedValue({ db: db.db, accountId: 'acc-1', userId: 'user-1', role: 'agent' })
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadAiConfig.mockResolvedValue({ provider: 'openai', model: 'gpt', apiKey: 'sk-secret', baseUrl: null })
  mocks.generateReply.mockResolvedValue({
    text: JSON.stringify({
      template: { name: 'sale' },
      variables: { '1': { type: 'field', value: 'name' } },
      segment: { name: 'VIPs', conditions: [{ field: 'tags', op: 'has_any', tags: ['VIP'] }] },
      send_at: null,
      notes: 'Short and sweet.',
    }),
    handoff: false,
    usage: null,
  })
  mocks.beforeAttempt.mockResolvedValue(undefined)
  mocks.finish.mockResolvedValue(undefined)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ai/campaign-assistant', () => {
  it('returns a draft only, with the approved template row', async () => {
    const res = await POST(req({ goal: 'Weekend sale', audience: 'VIP customers', timezone: 'Asia/Kolkata' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template.id).toBe('tpl-1')
    expect(body.draft).toMatchObject({
      templateId: 'tpl-1',
      variables: { '1': { type: 'field', value: 'name' } },
      segment: { name: 'VIPs', filter: { conditions: [{ field: 'tags', op: 'has_any', tagIds: [TAG] }] } },
      sendAt: null,
    })
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(db.touched).not.toContain('broadcasts')
    expect(db.touched).not.toContain('segments')
    expect(mocks.requestMeter).toHaveBeenCalledWith('acc-1', 20_000, expect.objectContaining({ mode: 'draft', conversationId: null }))
    expect(mocks.afterAttempt).toHaveBeenCalledTimes(1)
    expect(mocks.finish).toHaveBeenCalledTimes(1)
    const system = mocks.generateReply.mock.calls[0][0].systemPrompt as string
    expect(system).toContain('Asia/Kolkata')
    expect(JSON.stringify(body)).not.toContain('sk-secret')
  })

  it('needs approved templates before spending an AI message', async () => {
    db = fakeDb([])
    mocks.requireRole.mockResolvedValue({ db: db.db, accountId: 'acc-1', userId: 'user-1', role: 'agent' })
    const res = await POST(req({ goal: 'g' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('no_approved_templates')
    expect(mocks.beforeAttempt).not.toHaveBeenCalled()
  })

  it('validates input and rate limits', async () => {
    expect((await POST(req({ goal: '' }))).status).toBe(400)
    expect((await POST(req({ goal: 'g', audience: 'a'.repeat(1001) }))).status).toBe(400)
    mocks.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await POST(req({ goal: 'g' }))).status).toBe(429)
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('returns 422 when the model keeps inventing a template', async () => {
    mocks.generateReply.mockResolvedValue({ text: '{"template":{"name":"fake"}}', handoff: false, usage: null })
    const res = await POST(req({ goal: 'g' }))
    expect(res.status).toBe(422)
    expect(mocks.generateReply).toHaveBeenCalledTimes(2)
    // Both attempts are collected and settled once: one AI message per request.
    expect(mocks.afterAttempt).toHaveBeenCalledTimes(2)
    expect(mocks.finish).toHaveBeenCalledTimes(1)
  })
})
