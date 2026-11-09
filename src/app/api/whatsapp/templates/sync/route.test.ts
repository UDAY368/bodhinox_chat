import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Sync from Meta" rewrites the local catalog from Meta's components.
// Covered here: a stored carousel keeps the per-card media URL that every
// send needs (Meta returns only header handles), and a reason-less
// rejection is stored and recorded the same way the webhook stores it.

const state = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  numbers: [] as Record<string, unknown>[],
}))

function makeDb() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.single = async () =>
        table === 'whatsapp_config'
          ? { data: { waba_id: 'WABA-1', access_token: 'enc' }, error: null }
          : { data: { id: 'new-row' }, error: null }
      b.maybeSingle = async () => ({ data: state.existing, error: null })
      if (table === 'whatsapp_config') {
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: state.numbers, error: null })
      }
      b.update = (row: Record<string, unknown>) => {
        state.updates.push(row)
        return { eq: async () => ({ error: null }) }
      }
      b.insert = (row: Record<string, unknown>) => {
        state.inserts.push(row)
        return b
      }
      return b
    },
  }
}

vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return {
    UnauthorizedError,
    ForbiddenError,
    requireRole: vi.fn(async () => ({ db: makeDb(), accountId: 'acct-1', userId: 'user-1', role: 'admin' })),
    toErrorResponse: vi.fn(),
  }
})
vi.mock('@/lib/audience/http', () => ({ tenantOf: () => ({ accountId: 'acct-1', userId: 'user-1', role: 'admin' }) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }))
const history = vi.hoisted(() => ({ record: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1) }))
vi.mock('@/lib/whatsapp/template-events', async (importOriginal) => ({
  normalizeRejectionReason: (await importOriginal<typeof import('@/lib/whatsapp/template-events')>()).normalizeRejectionReason,
  recordTemplateEvents: history.record,
}))

import { POST } from './route'

const card = (format: 'IMAGE' | 'VIDEO', handle: string, text: string) => ({
  components: [
    { type: 'HEADER', format, example: { header_handle: [handle] } },
    { type: 'BODY', text },
  ],
})

function metaReturns(templates: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: templates }), { status: 200 })))
}

beforeEach(() => {
  state.existing = null
  state.updates.length = 0
  state.inserts.length = 0
  state.numbers = [{ id: 'n-1', waba_id: 'WABA-1', access_token: 'enc', is_default: true, created_at: '2026-01-01T00:00:00Z' }]
  history.record.mockClear()
})

describe('POST /api/whatsapp/templates/sync — carousel media', () => {
  const carousel = (cards: unknown[]) => ({
    id: 'meta-1', name: 'promo', language: 'en_US', status: 'APPROVED', category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Deals' }, { type: 'CAROUSEL', cards }],
  })

  it('keeps each stored card header_media_url when the carousel is unchanged', async () => {
    state.existing = {
      id: 'row-1',
      template_kind: 'carousel',
      cards: [
        { header_type: 'image', header_media_url: 'media/a.jpg', body_text: 'old A', buttons: [] },
        { header_type: 'video', header_media_url: 'media/b.mp4', body_text: 'old B', buttons: [] },
      ],
    }
    metaReturns([carousel([card('IMAGE', 'h-a', 'A'), card('VIDEO', 'h-b', 'B')])])
    const res = await POST()
    expect(res.status).toBe(200)
    const cards = state.updates[0].cards as Record<string, unknown>[]
    expect(cards.map((c) => [c.header_media_url, c.header_handle, c.body_text])).toEqual([
      ['media/a.jpg', 'h-a', 'A'],
      ['media/b.mp4', 'h-b', 'B'],
    ])
  })

  it('does not carry media onto a card whose header type changed or when the card count differs', async () => {
    state.existing = {
      id: 'row-1',
      template_kind: 'carousel',
      cards: [
        { header_type: 'image', header_media_url: 'media/a.jpg', body_text: 'A', buttons: [] },
        { header_type: 'image', header_media_url: 'media/b.jpg', body_text: 'B', buttons: [] },
      ],
    }
    metaReturns([carousel([card('IMAGE', 'h-a', 'A'), card('VIDEO', 'h-b', 'B')])])
    await POST()
    let cards = state.updates[0].cards as Record<string, unknown>[]
    expect(cards.map((c) => c.header_media_url)).toEqual(['media/a.jpg', undefined])

    state.updates.length = 0
    metaReturns([carousel([card('IMAGE', 'h-a', 'A')])])
    await POST()
    cards = state.updates[0].cards as Record<string, unknown>[]
    expect(cards[0].header_media_url).toBeUndefined()
  })
})

describe('POST /api/whatsapp/templates/sync — rejection reason', () => {
  it.each(['NONE', undefined])('stores and records no reason for a REJECTED template with %j', async (reason) => {
    state.existing = { id: 'row-1', template_kind: 'standard', cards: null }
    metaReturns([{
      id: 'meta-2', name: 'n', language: 'en_US', status: 'REJECTED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi' }], rejected_reason: reason,
    }])
    await POST()
    expect(state.updates[0].rejection_reason).toBeNull()
    const [, events] = history.record.mock.calls[0] as [unknown, { reason: unknown }[]]
    expect(events[0].reason).toBeNull()
  })

  it('keeps a real rejection reason', async () => {
    state.existing = { id: 'row-1', template_kind: 'standard', cards: null }
    metaReturns([{
      id: 'meta-2', name: 'n', language: 'en_US', status: 'REJECTED', category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hi' }], rejected_reason: 'INVALID_FORMAT',
    }])
    await POST()
    expect(state.updates[0].rejection_reason).toBe('INVALID_FORMAT')
  })
})

describe('POST /api/whatsapp/templates/sync — numbers in two WABAs', () => {
  const tpl = (id: string, name: string) => ({
    id, name, language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi' }],
  })

  it('fetches each WABA once with its own number and stamps every row with its WABA', async () => {
    state.numbers = [
      { id: 'n-1', waba_id: 'WABA-1', access_token: 'enc', is_default: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'n-2', waba_id: 'WABA-2', access_token: 'enc', is_default: false, created_at: '2026-02-01T00:00:00Z' },
      { id: 'n-3', waba_id: 'WABA-1', access_token: 'enc', is_default: false, created_at: '2026-03-01T00:00:00Z' },
    ]
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({
      data: [url.includes('/WABA-2/') ? tpl('m-2', 'two') : tpl('m-1', 'one')],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await POST()
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.inserts.map((row) => [row.name, row.waba_id])).toEqual([['one', 'WABA-1'], ['two', 'WABA-2']])
  })

  it('never writes a same-named template from another WABA over the stored one', async () => {
    state.numbers = [
      { id: 'n-1', waba_id: 'WABA-1', access_token: 'enc', is_default: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'n-2', waba_id: 'WABA-2', access_token: 'enc', is_default: false, created_at: '2026-02-01T00:00:00Z' },
    ]
    state.existing = { id: 'row-1', template_kind: 'standard', cards: null, waba_id: 'WABA-1' }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [tpl('m-x', 'same')] }), { status: 200 })))
    const res = await POST()
    const body = await res.json()
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].waba_id).toBe('WABA-1')
    expect(body.errors).toHaveLength(1)
  })

  it('reports a workspace with no number as not configured', async () => {
    state.numbers = []
    expect((await POST()).status).toBe(400)
  })
})


describe('POST /api/whatsapp/templates/sync — Meta timeout (audit finding 16)', () => {
  it('bounds every Meta page request with a timeout signal', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await POST()).status).toBe(200)
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers 504 with a clear message and writes nothing when Meta does not answer in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }))
    const res = await POST()
    expect(res.status).toBe(504)
    expect((await res.json()).error).toMatch(/did not answer in time/)
    expect(state.inserts).toEqual([])
    expect(state.updates).toEqual([])
  })
})
