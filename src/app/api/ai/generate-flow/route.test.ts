import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  requireAiMessageRoom: vi.fn(),
  recordAiMessage: vi.fn(),
  logAiUsage: vi.fn(),
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
vi.mock('@/lib/ai/usage', () => ({ logAiUsage: mocks.logAiUsage }))
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: () => ({}) }))
vi.mock('@/lib/billing/limits', () => ({ requireAiMessageRoom: mocks.requireAiMessageRoom, recordAiMessage: mocks.recordAiMessage }))

import { POST } from './route'

const flowJson = {
  name: 'Welcome',
  trigger: { type: 'keyword', keywords: ['hi'] },
  entry: 'hello',
  nodes: [
    { key: 'hello', type: 'send_message', config: { text: 'Hello!', next: 'done' } },
    { key: 'done', type: 'end', config: {} },
  ],
}

function fakeDb() {
  const writes: Array<{ table: string; payload: unknown }> = []
  const db = {
    from(table: string) {
      return {
        select: () => ({ is: () => ({ limit: async () => ({ data: [{ id: '11111111-1111-4111-8111-111111111111', name: 'VIP' }], error: null }) }) }),
        insert(payload: unknown) {
          writes.push({ table, payload })
          if (table === 'flows') return { select: () => ({ single: async () => ({ data: { id: 'flow-9', ...(payload as object) }, error: null }) }) }
          return Promise.resolve({ error: null })
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
      }
    },
  }
  return { db, writes }
}

const req = (body: unknown) => new Request('https://crm.test/api/ai/generate-flow', { method: 'POST', body: JSON.stringify(body) })
let db: ReturnType<typeof fakeDb>

beforeEach(() => {
  db = fakeDb()
  mocks.requireRole.mockResolvedValue({ db: db.db, accountId: 'acc-1', userId: 'user-1', role: 'agent' })
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadAiConfig.mockResolvedValue({ provider: 'openai', model: 'gpt', apiKey: 'sk-secret', baseUrl: null })
  mocks.generateReply.mockResolvedValue({ text: JSON.stringify(flowJson), handoff: false, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
  mocks.requireAiMessageRoom.mockResolvedValue(undefined)
  mocks.recordAiMessage.mockResolvedValue(undefined)
})
afterEach(() => vi.clearAllMocks())

describe('POST /api/ai/generate-flow', () => {
  it('creates a draft flow with laid-out nodes for agents', async () => {
    const log = vi.spyOn(console, 'log')
    const err = vi.spyOn(console, 'error')
    const res = await POST(req({ goal: 'Greet people who say hi' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.flow.id).toBe('flow-9')
    expect(body.issues).toEqual([])
    expect(mocks.requireRole).toHaveBeenCalledWith('agent')
    expect(db.writes[0]).toMatchObject({ table: 'flows', payload: { status: 'draft', account_id: 'acc-1', user_id: 'user-1' } })
    const nodes = db.writes[1].payload as Array<{ node_key: string; position_x: number }>
    expect(nodes.map((n) => n.node_key)).toEqual(['start', 'hello', 'done'])
    expect(nodes.every((n) => n.position_x > 0)).toBe(true)
    expect(mocks.requireAiMessageRoom).toHaveBeenCalledWith('acc-1')
    expect(mocks.recordAiMessage).toHaveBeenCalledTimes(1)
    expect(mocks.logAiUsage).toHaveBeenCalledWith({}, expect.objectContaining({ accountId: 'acc-1', mode: 'draft', conversationId: null }))
    // The goal and the model output never reach the logs or the response key.
    for (const call of [...log.mock.calls, ...err.mock.calls]) expect(JSON.stringify(call)).not.toContain('Greet people')
    expect(JSON.stringify(body)).not.toContain('sk-secret')
  })

  it('rejects a missing or oversized goal before calling the model', async () => {
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req({ goal: 'x'.repeat(2001) }))).status).toBe(400)
    expect(mocks.generateReply).not.toHaveBeenCalled()
  })

  it('is rate limited', async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ success: false })
    expect((await POST(req({ goal: 'g' }))).status).toBe(429)
  })

  it('needs a configured AI provider', async () => {
    mocks.loadAiConfig.mockResolvedValueOnce(null)
    const res = await POST(req({ goal: 'g' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('ai_not_configured')
  })

  it('stops on the plan AI message limit without creating anything', async () => {
    mocks.requireAiMessageRoom.mockRejectedValueOnce(Object.assign(new Error('AI messages used up'), { status: 402 }))
    const res = await POST(req({ goal: 'g' }))
    expect(res.status).toBe(402)
    expect(mocks.generateReply).not.toHaveBeenCalled()
    expect(db.writes).toEqual([])
  })

  it('refuses viewers through the role check', async () => {
    mocks.requireRole.mockRejectedValueOnce(Object.assign(new Error('Insufficient workspace role'), { status: 403 }))
    expect((await POST(req({ goal: 'g' }))).status).toBe(403)
  })

  it('returns 422 and creates nothing when the model never returns JSON', async () => {
    mocks.generateReply.mockResolvedValue({ text: 'sorry', handoff: false, usage: null })
    const res = await POST(req({ goal: 'g' }))
    expect(res.status).toBe(422)
    expect(mocks.generateReply).toHaveBeenCalledTimes(2)
    expect(db.writes).toEqual([])
  })
})
