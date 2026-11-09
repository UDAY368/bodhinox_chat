import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  contexts: [] as unknown[],
  dbs: [] as unknown[],
}))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown, db?: unknown) => {
    h.contexts.push(ctx)
    h.dbs.push(db)
    return fn({ $executeRaw: h.executeRaw, $queryRaw: h.queryRaw })
  },
}))

import {
  ActivityQueryError, MAX_CUSTOMER_TEXT_CHARS, MAX_REPLY_TEXT_CHARS, capText, decodeActivityCursor, encodeActivityCursor,
  getReplyEvent, listReplyEvents, parseActivityQuery, recordReplyEvent, replyEventRow, trimSources,
} from './reply-events'

const A = '11111111-1111-4111-8111-111111111111'
const CONV = '22222222-2222-4222-8222-222222222222'
const EVENT = '33333333-3333-4333-8333-333333333333'
const SECRET = 'my card is 4111 1111 1111 1111'
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?')

beforeEach(() => {
  h.executeRaw.mockReset().mockResolvedValue(1)
  h.queryRaw.mockReset()
  h.contexts.length = 0
  h.dbs.length = 0
})
afterEach(() => vi.restoreAllMocks())

describe('replyEventRow', () => {
  it('caps customer text and reply to the table limits, by code point', () => {
    const row = replyEventRow({
      accountId: A, outcome: 'replied', reason: 'answered',
      customerText: '😀'.repeat(MAX_CUSTOMER_TEXT_CHARS + 50), replyText: 'r'.repeat(MAX_REPLY_TEXT_CHARS + 1),
    })
    expect(Array.from(row.customer_text!)).toHaveLength(MAX_CUSTOMER_TEXT_CHARS)
    expect(row.customer_text!.endsWith('😀')).toBe(true)
    expect(row.reply_text).toHaveLength(MAX_REPLY_TEXT_CHARS)
  })

  it('keeps at most five distinct documents as {document_id, title}, never chunk text or urls', () => {
    const citations = Array.from({ length: 8 }, (_, i) => ({
      chunk_id: `c${i}`, document_id: `d${i % 6}`, title: `Doc ${i}`, source_url: 'https://example.com', content: 'chunk text',
    }))
    const sources = trimSources([{ document_id: null, title: 'no id' }, ...citations])
    expect(sources).toEqual([0, 1, 2, 3, 4].map((i) => ({ document_id: `d${i}`, title: `Doc ${i}` })))
    expect(JSON.stringify(sources)).not.toContain('chunk text')
    expect(JSON.stringify(sources)).not.toContain('example.com')
  })

  it('normalises ids, reason, flags, numbers and blanks', () => {
    const row = replyEventRow({
      accountId: A, conversationId: 'conv-1', contactId: CONV.toUpperCase(), outcome: 'error', reason: 'Bad Reason!',
      customerText: '  ', confidence: 1.7, guardFlags: ['claim_payment', 'claim_payment', 'has space', 'x'.repeat(65)],
      promptTokens: -3, completionTokens: 2.6, totalTokens: Number.NaN, latencyMs: 12.4, model: 'm'.repeat(300),
    })
    expect(row).toMatchObject({
      conversation_id: null, contact_id: CONV, reason: 'unknown', customer_text: null, confidence: 1,
      guard_flags: ['claim_payment'], prompt_tokens: 0, completion_tokens: 3, total_tokens: 0, latency_ms: 12,
    })
    expect(row.model).toHaveLength(200)
    expect(capText('a\u0000b', 10)).toBe('ab')
  })
})

describe('recordReplyEvent', () => {
  it('inserts one row on the worker role inside the workspace', async () => {
    await recordReplyEvent({
      accountId: A, conversationId: CONV, outcome: 'handed_off', reason: 'guard_blocked', customerText: 'hello',
      guardFlags: ['claim_refund'], sources: [{ document_id: 'd1', title: 'FAQ' }],
    })
    expect(h.contexts).toEqual([{ accountId: A, role: 'owner' }])
    expect(h.dbs).toEqual([{ worker: true }])
    const call = h.executeRaw.mock.calls[0]
    expect(sqlOf(call)).toContain('INSERT INTO ai_reply_events')
    expect(call).toContain(A)
    expect(call).toContain('hello')
    expect(call).toContain(JSON.stringify([{ document_id: 'd1', title: 'FAQ' }]))
    expect(call).toContainEqual(['claim_refund'])
  })

  it('never throws, and logs only a reason code and the error class', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.executeRaw.mockRejectedValue(Object.assign(new Error(`insert failed for ${SECRET}`), { name: 'PrismaClientKnownRequestError' }))
    await expect(recordReplyEvent({ accountId: A, outcome: 'replied', reason: 'answered', customerText: SECRET, replyText: SECRET }))
      .resolves.toBeUndefined()
    const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls])
    expect(logged).toContain('insert_failed')
    expect(logged).toContain('PrismaClientKnownRequestError')
    expect(logged).not.toContain('4111')
    expect(logged).not.toContain(A)
  })

  it('ignores an unknown outcome without writing', async () => {
    await recordReplyEvent({ accountId: A, outcome: 'nope' as never, reason: 'x' })
    expect(h.executeRaw).not.toHaveBeenCalled()
  })
})

describe('parseActivityQuery', () => {
  const q = (s: string) => parseActivityQuery(new URLSearchParams(s))

  it('parses filters with defaults', () => {
    expect(q('')).toMatchObject({ limit: 50 })
    const parsed = q(`outcome=handed_off&reason=guard_blocked&contact_id=${CONV}&from=2026-11-01&to=2026-11-02T10:00:00Z&limit=10`)
    expect(parsed).toMatchObject({ outcome: 'handed_off', reason: 'guard_blocked', contactId: CONV, limit: 10 })
    expect(parsed.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
  })

  it('rejects malformed input', () => {
    for (const bad of ['outcome=sent', 'reason=DROP TABLE', `reason=${'a'.repeat(65)}`, 'contact_id=me', 'from=yesterday',
      'limit=0', 'limit=101', 'limit=2.5', 'from=2026-11-03&to=2026-11-01', 'cursor=abc'])
      expect(() => q(bad), bad).toThrow(ActivityQueryError)
  })

  it('round-trips a microsecond cursor and refuses a forged one', () => {
    const cursor = encodeActivityCursor('2026-11-02 10:11:12.123456+00', EVENT)
    expect(decodeActivityCursor(cursor)).toEqual({ at: '2026-11-02 10:11:12.123456+00', id: EVENT })
    expect(() => decodeActivityCursor(Buffer.from(`now()|${EVENT}`).toString('base64url'))).toThrow(ActivityQueryError)
  })

  it.each(['2026-11-02 10:11:12+05:30', '2026-11-02T10:11:12Z', '2024-02-29 23:59:59.5-08'])('accepts the timestamp %s', (at) => {
    expect(decodeActivityCursor(encodeActivityCursor(at, EVENT)).at).toBe(at)
  })

  it.each([
    '2026-99-99 00:00:00', '2026-01-01 ::::::::', '2026-02-30 10:00:00+00', '2025-02-29 10:00:00+00',
    '2026-01-01 24:00:00+00', '2026-01-01 10:60:00+00', '2026-01-01 10:00:60+00', '2026-01-01 10:00:00+16',
    '2026-01-01 10:00:00.1234567+00',
  ])('refuses a cursor PostgreSQL would reject: %s', (at) => {
    expect(() => decodeActivityCursor(encodeActivityCursor(at, EVENT))).toThrow(ActivityQueryError)
  })
})

describe('listReplyEvents / getReplyEvent', () => {
  const tenant = { accountId: A, userId: CONV, role: 'admin' as const }
  const listRow = (n: number) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at_key: `2026-11-02 10:00:0${n}.123456+00`,
    created_at: new Date(`2026-11-02T10:00:0${n}Z`), conversation_id: CONV, contact_id: CONV, contact_name: 'Asha',
    contact_phone: '+919800000001', outcome: 'replied', reason: 'answered', preview: 'hi', has_reply: true, model: 'gpt',
    total_tokens: 12, latency_ms: 900,
  })

  it('pages newest first with a keyset cursor, scoped to the workspace', async () => {
    h.queryRaw.mockResolvedValue([listRow(3), listRow(2), listRow(1)])
    const page = await listReplyEvents(tenant, { limit: 2, outcome: 'replied' })
    expect(page.events.map((e) => e.id)).toEqual([listRow(3).id, listRow(2).id])
    expect(page.events[0]).toMatchObject({ contact: { id: CONV, name: 'Asha', phone: '+919800000001' }, created_at: '2026-11-02T10:00:03.000Z' })
    expect(decodeActivityCursor(page.next_cursor!)).toEqual({ at: listRow(2).at_key, id: listRow(2).id })
    const sql = sqlOf(h.queryRaw.mock.calls[0])
    expect(sql).toContain('ORDER BY e.created_at DESC, e.id DESC')
    expect(sql).toContain('left(e.customer_text, ?::int)')
    expect(h.contexts).toEqual([tenant])
  })

  it('has no cursor on the last page', async () => {
    h.queryRaw.mockResolvedValue([listRow(1)])
    expect((await listReplyEvents(tenant, { limit: 2 })).next_cursor).toBeNull()
  })

  it('returns null for an id outside the workspace or a malformed one', async () => {
    h.queryRaw.mockResolvedValue([])
    expect(await getReplyEvent(tenant, EVENT)).toBeNull()
    expect(await getReplyEvent(tenant, 'not-a-uuid')).toBeNull()
    expect(h.queryRaw).toHaveBeenCalledTimes(1)
  })
})
