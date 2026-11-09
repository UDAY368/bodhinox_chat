import { beforeEach, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const h = vi.hoisted(() => ({ role: 'admin', rows: [] as unknown[], sql: [] as string[], params: [] as unknown[][], contexts: [] as unknown[] }))

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
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx)
    return fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        h.sql.push(strings.join('?'))
        h.params.push(values)
        return h.rows
      },
    })
  },
}))

import { GET } from './route'
import { GET as GET_ONE } from './[id]/route'

const row = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at_key: `2026-11-02 10:00:0${n}.123456+00`,
  created_at: new Date(`2026-11-02T10:00:0${n}Z`), conversation_id: null, contact_id: null, contact_name: null, contact_phone: null,
  outcome: 'replied', reason: 'answered', preview: 'hi', has_reply: true, model: 'gpt', total_tokens: 5, latency_ms: 800,
})
const one = (id: string) => GET_ONE(new Request(`http://x/api/ai/activity/${id}`), { params: Promise.resolve({ id }) })

beforeEach(() => {
  h.role = 'admin'
  h.rows = []
  h.sql = []
  h.params = []
  h.contexts = []
})

it.each(['agent', 'viewer'])('refuses a %s on both routes', async (role) => {
  h.role = role
  expect((await GET(new Request('http://x/api/ai/activity'))).status).toBe(403)
  expect((await one(EVENT)).status).toBe(403)
  expect(h.sql).toEqual([])
})

it('pages newest first for an admin, private and uncached, in the caller workspace', async () => {
  h.rows = [row(3), row(2), row(1)]
  const res = await GET(new Request('http://x/api/ai/activity?limit=2&outcome=replied'))
  expect(res.status).toBe(200)
  expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await res.json()
  expect(body.events.map((e: { id: string }) => e.id)).toEqual([row(3).id, row(2).id])
  expect(body.next_cursor).toBeTruthy()
  expect(h.contexts).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'admin' }])
  expect(h.params[0]).toContain('replied')

  // The cursor continues strictly after the last row of the page.
  h.rows = [row(1)]
  const next = await (await GET(new Request(`http://x/api/ai/activity?limit=2&cursor=${body.next_cursor}`))).json()
  expect(next.next_cursor).toBeNull()
  expect(h.params[1]).toEqual(expect.arrayContaining([row(2).at_key, row(2).id]))
})

const forgedCursor = (at: string) => `cursor=${Buffer.from(`${at}|${EVENT}`).toString('base64url')}`

it.each([
  'outcome=sent', 'reason=Not-A-Code', 'contact_id=me', 'from=soon', 'limit=0', 'limit=101', 'cursor=forged',
  // Shaped like a timestamp but out of range: refused before any SQL, never a 500 from ::timestamptz.
  forgedCursor('2026-99-99 00:00:00'), forgedCursor('2026-01-01 ::::::::'),
])('rejects an invalid query: %s', async (query) => {
  const res = await GET(new Request(`http://x/api/ai/activity?${query}`))
  expect(res.status).toBe(400)
  expect((await res.json()).code).toBe('invalid_query')
  expect(h.sql).toEqual([])
})

it('answers 404 for an id outside the workspace or a malformed one', async () => {
  expect((await one(EVENT)).status).toBe(404)
  expect((await one('not-a-uuid')).status).toBe(404)
})

it('returns the full row for an admin', async () => {
  h.rows = [{
    id: EVENT, created_at: new Date('2026-11-02T10:00:00Z'), conversation_id: null, contact_id: null, contact_name: null, contact_phone: null,
    inbound_message_id: 'wamid.1', outcome: 'handed_off', reason: 'guard_blocked', customer_text: 'full question', reply_text: null,
    sources: [{ document_id: 'd1', title: 'FAQ' }], confidence: 0.75, guard_flags: ['claim_refund'], provider: 'openai', model: 'gpt',
    prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, latency_ms: 1200,
  }]
  const res = await one(EVENT)
  expect(res.status).toBe(200)
  expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  expect((await res.json()).event).toMatchObject({
    id: EVENT, customer_text: 'full question', sources: [{ document_id: 'd1', title: 'FAQ' }], confidence: 0.75,
    guard_flags: ['claim_refund'], total_tokens: 14,
  })
})
