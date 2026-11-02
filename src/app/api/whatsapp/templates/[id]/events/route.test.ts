vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'user-1', accountId: ACCOUNT, role: callerRole, sessionId: 'session-1' }) }));
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const TEMPLATE_ID = '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
let callerRole = 'viewer'
let template: { id: string } | null = { id: TEMPLATE_ID }
const lookups: [string, unknown][][] = []

function makeDb() {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from(table: string) {
      const filters: [string, unknown][] = []
      if (table === 'message_templates') lookups.push(filters)
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn((f: string, v: unknown) => { filters.push([f, v]); return b })
      b.maybeSingle = vi.fn(async () =>
        table === 'accounts' ? { data: { id: ACCOUNT, name: 'Acme' }, error: null } : { data: template, error: null },
      )
      return b
    },
  }
}
vi.mock('@/lib/data/server', () => ({ createClient: vi.fn(async () => makeDb()) }))

const EVENTS = [
  { id: 'e2', status: 'APPROVED', reason: null, quality_score: 'GREEN', source: 'webhook', created_at: '2026-11-02T10:00:00.000Z' },
  { id: 'e1', status: 'PENDING', reason: null, quality_score: null, source: 'submit', created_at: '2026-11-01T10:00:00.000Z' },
]
const history = vi.hoisted(() => ({ list: vi.fn(async () => [] as unknown[]) }))
vi.mock('@/lib/whatsapp/template-events', () => ({ listTemplateEvents: history.list }))

import { GET } from './route'

const get = (id = TEMPLATE_ID) => GET(new Request('http://localhost/t'), { params: Promise.resolve({ id }) })

beforeEach(() => {
  callerRole = 'viewer'
  template = { id: TEMPLATE_ID }
  lookups.length = 0
  history.list.mockReset()
  history.list.mockResolvedValue(EVENTS)
})

describe('GET /api/whatsapp/templates/[id]/events', () => {
  it('returns the history to any member, scoped to their account', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ events: EVENTS })
    expect(lookups[0]).toEqual([['id', TEMPLATE_ID], ['account_id', ACCOUNT]])
    expect(history.list).toHaveBeenCalledWith(
      { accountId: ACCOUNT, userId: 'user-1', role: 'viewer' },
      TEMPLATE_ID,
    )
  })

  it('is a 404 for a template outside the account, without reading events', async () => {
    template = null
    const res = await get()
    expect(res.status).toBe(404)
    expect(history.list).not.toHaveBeenCalled()
  })

  it('rejects a malformed id', async () => {
    const res = await get('nope')
    expect(res.status).toBe(400)
  })

  it('does not leak database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    history.list.mockRejectedValueOnce(new Error('relation secret_table does not exist'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_table')
  })
})
