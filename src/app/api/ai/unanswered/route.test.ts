import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listUnanswered: vi.fn(),
  answerUnanswered: vi.fn(),
  dismissUnanswered: vi.fn(),
  promoteToKnowledge: vi.fn(),
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/ai/unanswered', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/unanswered')>()),
  listUnanswered: h.listUnanswered,
  answerUnanswered: h.answerUnanswered,
  dismissUnanswered: h.dismissUnanswered,
  promoteToKnowledge: h.promoteToKnowledge,
}))

import { GET } from './route'
import { POST } from './[id]/route'
import { UnansweredError } from '@/lib/ai/unanswered'

const db = { marker: 'route-db' }
const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' }
const ID = '33333333-3333-4333-8333-333333333333'
const act = (body: unknown) => POST(
  new Request('https://crm.test/api/ai/unanswered/' + ID, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: ID }) },
)
const forbidden = () => Object.assign(new Error('Insufficient workspace role'), { status: 403 })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ ...ctx, db })
})

it('lists open questions for agents with clamped paging', async () => {
  h.listUnanswered.mockResolvedValue({ items: [], total: 0 })
  const res = await GET(new Request('https://crm.test/api/ai/unanswered?limit=500&offset=10'))
  expect(res.status).toBe(200)
  expect(h.requireRole).toHaveBeenCalledWith('agent')
  expect(h.listUnanswered).toHaveBeenCalledWith(ctx, { status: 'open', limit: 100, offset: 10 })
})

it('rejects an unknown status', async () => {
  const res = await GET(new Request('https://crm.test/api/ai/unanswered?status=all'))
  expect(res.status).toBe(400)
  expect(h.listUnanswered).not.toHaveBeenCalled()
})

it('refuses viewers', async () => {
  h.requireRole.mockRejectedValue(forbidden())
  expect((await GET(new Request('https://crm.test/api/ai/unanswered'))).status).toBe(403)
  expect((await act({ action: 'dismiss' })).status).toBe(403)
  expect(h.dismissUnanswered).not.toHaveBeenCalled()
})

it('answers a question', async () => {
  h.answerUnanswered.mockResolvedValue({ id: ID, status: 'answered' })
  const res = await act({ action: 'answer', answer: 'Yes, we ship there.' })
  expect(res.status).toBe(200)
  expect(h.requireRole).toHaveBeenCalledWith('agent')
  expect(h.answerUnanswered).toHaveBeenCalledWith(ctx, ID, { answer: 'Yes, we ship there.' })
})

it('maps library validation and role errors to their status', async () => {
  h.answerUnanswered.mockRejectedValue(new UnansweredError('Enter an answer'))
  expect((await act({ action: 'answer', answer: '' })).status).toBe(400)
  h.promoteToKnowledge.mockRejectedValue(new UnansweredError('Only admins can teach the AI agent', 403))
  expect((await act({ action: 'promote' })).status).toBe(403)
})

it('returns 404 when the question is not in this workspace', async () => {
  h.answerUnanswered.mockResolvedValue(null)
  h.dismissUnanswered.mockResolvedValue(false)
  h.promoteToKnowledge.mockResolvedValue(null)
  expect((await act({ action: 'answer', answer: 'x' })).status).toBe(404)
  expect((await act({ action: 'dismiss' })).status).toBe(404)
  expect((await act({ action: 'promote' })).status).toBe(404)
})

it('promotes with the caller-scoped data client and the answer the admin reviewed', async () => {
  h.promoteToKnowledge.mockResolvedValue({ documentId: 'd1', sourceId: 's1', indexed: true })
  const res = await act({ action: 'promote', answer: 'Yes, 10 to 6.' })
  expect(await res.json()).toEqual({ documentId: 'd1', sourceId: 's1', indexed: true })
  expect(h.promoteToKnowledge).toHaveBeenCalledWith(ctx, ID, db, 'Yes, 10 to 6.')
})

it('returns 409 when an agent changed the answer after the admin reviewed it', async () => {
  h.promoteToKnowledge.mockRejectedValue(new UnansweredError('The answer changed since you reviewed it.', 409))
  expect((await act({ action: 'promote', answer: 'old text' })).status).toBe(409)
})

it('rejects an unknown action', async () => {
  expect((await act({ action: 'delete' })).status).toBe(400)
})
