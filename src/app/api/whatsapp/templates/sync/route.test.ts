import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Sync from Meta" rewrites the local catalog from Meta's components.
// Covered here: a stored carousel keeps the per-card media URL that every
// send needs (Meta returns only header handles), and a reason-less
// rejection is stored and recorded the same way the webhook stores it.

const state = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
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
