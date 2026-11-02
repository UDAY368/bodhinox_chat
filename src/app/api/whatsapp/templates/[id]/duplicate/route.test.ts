vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'user-1', accountId: ACCOUNT, role: callerRole, sessionId: 'session-1' }) }));
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const SOURCE_ID = '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const COPY_ID = '4f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
let callerRole = 'admin'

const SOURCE = {
  id: SOURCE_ID,
  name: 'weekly_picks',
  category: 'Marketing',
  language: 'pt_BR',
  template_kind: 'carousel',
  header_type: null,
  header_content: null,
  header_media_url: null,
  header_handle: null,
  body_text: 'Our picks for you',
  footer_text: null,
  buttons: null,
  sample_values: null,
  cards: [
    { header_type: 'image', header_media_url: 'https://cdn.example/1.jpg', body_text: 'One', buttons: [{ type: 'QUICK_REPLY', text: 'Buy' }] },
    { header_type: 'image', header_media_url: 'https://cdn.example/2.jpg', body_text: 'Two', buttons: [{ type: 'QUICK_REPLY', text: 'Buy' }] },
  ],
  auth_options: null,
  lto: null,
}

interface Op { table: string; kind: string; values?: Record<string, unknown>; filters: [string, unknown][]; like?: string }
const ops: Op[] = []
let source: typeof SOURCE | null = SOURCE
let siblings: { name: string }[] = []
let insertError: { message: string; code?: string } | null = null

function makeDb() {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from(table: string) {
      const op: Op = { table, kind: 'select', filters: [] }
      ops.push(op)
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.limit = vi.fn(chain)
      b.like = vi.fn((_f: string, v: string) => { op.like = v; return b })
      b.eq = vi.fn((f: string, v: unknown) => { op.filters.push([f, v]); return b })
      b.insert = vi.fn((v: Record<string, unknown>) => { op.kind = 'insert'; op.values = v; return b })
      const result = async () => {
        if (table === 'accounts') return { data: { id: ACCOUNT, name: 'Acme' }, error: null }
        if (op.kind === 'insert') {
          return insertError ? { data: null, error: insertError } : { data: { ...op.values, id: COPY_ID }, error: null }
        }
        if (op.like !== undefined) return { data: siblings, error: null }
        return { data: source, error: null }
      }
      b.single = vi.fn(result)
      b.maybeSingle = vi.fn(result)
      b.then = (resolve: (v: unknown) => unknown) => result().then(resolve)
      return b
    },
  }
}

vi.mock('@/lib/data/server', () => ({ createClient: vi.fn(async () => makeDb()) }))

const history = vi.hoisted(() => ({ record: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1) }))
vi.mock('@/lib/whatsapp/template-events', () => ({ recordTemplateEvents: history.record }))

import { POST } from './route'

const duplicate = (id = SOURCE_ID) =>
  POST(new Request('http://localhost/t', { method: 'POST' }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  ops.length = 0
  callerRole = 'admin'
  source = SOURCE
  siblings = [{ name: 'weekly_picks' }]
  insertError = null
  history.record.mockClear()
})

describe('POST /api/whatsapp/templates/[id]/duplicate', () => {
  for (const role of ['viewer', 'agent']) {
    it(`refuses a ${role}`, async () => {
      callerRole = role
      const res = await duplicate()
      expect(res.status).toBe(403)
      expect(ops.some((o) => o.kind === 'insert')).toBe(false)
    })
  }

  it('copies every content field into a DRAFT with no Meta lifecycle state', async () => {
    const res = await duplicate()
    expect(res.status).toBe(200)
    const insert = ops.find((o) => o.kind === 'insert')!
    const { id: _ignored, ...content } = SOURCE
    expect(_ignored).toBe(SOURCE_ID)
    expect(insert.values).toEqual({
      ...content,
      name: 'weekly_picks_copy',
      account_id: ACCOUNT,
      user_id: 'user-1',
      status: 'DRAFT',
      meta_template_id: null,
      rejection_reason: null,
      quality_score: null,
      submission_error: null,
      last_submitted_at: null,
    })
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT }),
      [{ templateId: COPY_ID, status: 'DRAFT', source: 'draft' }],
    )
  })

  it('looks for taken names in the same account and language only', async () => {
    siblings = [{ name: 'weekly_picks' }, { name: 'weekly_picks_copy' }, { name: 'weekly_picks_copy_2' }]
    await duplicate()
    const lookup = ops.find((o) => o.like !== undefined)!
    expect(lookup.filters).toEqual([['account_id', ACCOUNT], ['language', 'pt_BR']])
    expect(ops.find((o) => o.kind === 'insert')!.values!.name).toBe('weekly_picks_copy_3')
  })

  it('returns 404 for a template in another account', async () => {
    source = null
    const res = await duplicate()
    expect(res.status).toBe(404)
    expect(ops.some((o) => o.kind === 'insert')).toBe(false)
    const lookup = ops.find((o) => o.table === 'message_templates')!
    expect(lookup.filters).toContainEqual(['account_id', ACCOUNT])
  })

  it('rejects a malformed id', async () => {
    const res = await duplicate('../etc')
    expect(res.status).toBe(400)
  })

  it('maps a concurrent copy with the same name to 409', async () => {
    insertError = { message: 'duplicate', code: '23505' }
    const res = await duplicate()
    expect(res.status).toBe(409)
    expect(history.record).not.toHaveBeenCalled()
  })
})
