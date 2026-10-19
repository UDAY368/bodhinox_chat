import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn(), payload: null as Record<string, unknown> | null, filters: [] as unknown[], conversation: { id: 'conv-1' } as { id: string } | null }))
vi.mock('@/lib/auth/account', () => ({ requireRole: h.requireRole, toErrorResponse: () => new Response(null, { status: 500 }) }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response(null, { status: 429 }), RATE_LIMITS: { send: {} } }))
import { POST } from './route'

beforeEach(() => {
  h.payload = null
  h.filters = []
  h.conversation = { id: 'conv-1' }
  const chain = {
    select: () => chain,
    eq: (field: string, value: unknown) => { h.filters.push([field, value]); return chain },
    maybeSingle: async () => ({ data: h.conversation, error: null }),
    update: (payload: Record<string, unknown>) => { h.payload = payload; return chain },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  }
  h.requireRole.mockResolvedValue({ db: { from: () => chain }, accountId: 'acct-1', userId: 'agent-1' })
})

const toggle = (body: unknown) => POST(new Request('https://crm.test/api/ai/autoreply/conv-1', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ conversationId: 'conv-1' }) })

it('explicit Resume AI clears both pause flags and resets the handoff state', async () => {
  expect((await toggle({ paused: false })).status).toBe(200)
  expect(h.payload).toEqual({ ai_autoreply_disabled: false, bot_paused: false, assigned_agent_id: null, ai_reply_count: 0, ai_handoff_summary: null })
  expect(h.filters).toEqual([['id', 'conv-1'], ['account_id', 'acct-1'], ['id', 'conv-1'], ['account_id', 'acct-1']])
})

it('takeover sets both pause flags and optionally assigns the caller', async () => {
  expect((await toggle({ paused: true, assign_to_me: true })).status).toBe(200)
  expect(h.payload).toEqual({ ai_autoreply_disabled: true, bot_paused: true, assigned_agent_id: 'agent-1' })
})

it('does not update an inaccessible conversation', async () => {
  h.conversation = null
  expect((await toggle({ paused: false })).status).toBe(404)
  expect(h.payload).toBeNull()
})

it('rejects an invalid toggle before writing', async () => {
  expect((await toggle({ paused: 'false' })).status).toBe(400)
  expect(h.payload).toBeNull()
})
