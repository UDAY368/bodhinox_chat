vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'user-1', accountId: ACCOUNT, role: callerRole, sessionId: 'session-1' }) }));
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Draft save never reaches Meta: these tests pin the role gate, the
// "submitted templates are not drafts" rule, the name clash guard, the
// columns written, and the 'draft' status event.

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const DRAFT_ID = '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
let callerRole = 'admin'

interface Op { table: string; kind: string; values?: Record<string, unknown>; filters: [string, unknown][] }
const ops: Op[] = []
/** Rows the fake returns for (table, kind); kind is select|insert|update. */
let respond: (op: Op) => { data: unknown; error: unknown } = () => ({ data: null, error: null })

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
      b.like = vi.fn(chain)
      b.eq = vi.fn((f: string, v: unknown) => { op.filters.push([f, v]); return b })
      b.is = vi.fn((f: string, v: unknown) => { op.filters.push([f, v]); return b })
      b.insert = vi.fn((v: Record<string, unknown>) => { op.kind = 'insert'; op.values = v; return b })
      b.update = vi.fn((v: Record<string, unknown>) => { op.kind = 'update'; op.values = v; return b })
      const result = async () =>
        table === 'accounts' ? { data: { id: ACCOUNT, name: 'Acme' }, error: null } : respond(op)
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

function save(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/templates/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const DRAFT = {
  name: 'spring_sale',
  language: 'en_US',
  category: 'Marketing',
  template_kind: 'limited_time_offer',
  body_text: 'Half price until Sunday',
  lto: { text: 'Ends Sunday', has_expiration: true },
  cards: [{ header_type: 'image', body_text: 'ignored', buttons: [] }],
}

beforeEach(() => {
  ops.length = 0
  callerRole = 'admin'
  history.record.mockClear()
  respond = (op) =>
    op.kind === 'select'
      ? { data: null, error: null }
      : { data: { id: DRAFT_ID, ...op.values }, error: null }
})

describe('POST /api/whatsapp/templates/draft', () => {
  for (const role of ['viewer', 'agent']) {
    it(`refuses a ${role}`, async () => {
      callerRole = role
      const res = await save(DRAFT)
      expect(res.status).toBe(403)
      expect(ops.filter((o) => o.table === 'message_templates')).toHaveLength(0)
    })
  }

  it('inserts a new DRAFT with only its own kind fields and records a draft event', async () => {
    const res = await save(DRAFT)
    expect(res.status).toBe(200)
    const insert = ops.find((o) => o.kind === 'insert')!
    expect(insert.values).toMatchObject({
      account_id: ACCOUNT,
      user_id: 'user-1',
      name: 'spring_sale',
      status: 'DRAFT',
      template_kind: 'limited_time_offer',
      lto: { text: 'Ends Sunday', has_expiration: true },
      cards: null,
      auth_options: null,
    })
    expect(insert.values).not.toHaveProperty('meta_template_id')
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT }),
      [{ templateId: DRAFT_ID, status: 'DRAFT', source: 'draft' }],
    )
  })

  it('rejects a draft without a valid identity before touching the database', async () => {
    const res = await save({ ...DRAFT, name: 'Not Valid' })
    expect(res.status).toBe(400)
    expect(ops.filter((o) => o.table === 'message_templates')).toHaveLength(0)
  })

  it('refuses to overwrite another template with the same name and language', async () => {
    respond = (op) => (op.kind === 'select' ? { data: { id: 'other-id' }, error: null } : { data: null, error: null })
    const res = await save(DRAFT)
    expect(res.status).toBe(409)
    expect(ops.some((o) => o.kind === 'insert' || o.kind === 'update')).toBe(false)
    expect(history.record).not.toHaveBeenCalled()
  })

  it('updates an existing draft in place, only while it has no Meta id', async () => {
    respond = (op) => {
      if (op.kind === 'select') {
        return op.filters.some(([f]) => f === 'id')
          ? { data: { id: DRAFT_ID, meta_template_id: null }, error: null }
          : { data: { id: DRAFT_ID }, error: null } // its own name: not a clash
      }
      return { data: { id: DRAFT_ID, ...op.values }, error: null }
    }
    const res = await save({ ...DRAFT, id: DRAFT_ID })
    expect(res.status).toBe(200)
    const update = ops.find((o) => o.kind === 'update')!
    expect(update.filters).toEqual([
      ['id', DRAFT_ID],
      ['account_id', ACCOUNT],
      ['meta_template_id', null],
    ])
    expect(update.values).not.toHaveProperty('account_id')
    expect(update.values).toMatchObject({ status: 'DRAFT' })
  })

  it('sends submitted templates to the edit path (409)', async () => {
    respond = () => ({ data: { id: DRAFT_ID, meta_template_id: 'meta-1' }, error: null })
    const res = await save({ ...DRAFT, id: DRAFT_ID })
    expect(res.status).toBe(409)
    expect(ops.some((o) => o.kind === 'update')).toBe(false)
  })

  it('returns 404 for a draft id outside the account', async () => {
    respond = () => ({ data: null, error: null })
    const res = await save({ ...DRAFT, id: DRAFT_ID })
    expect(res.status).toBe(404)
  })

  it('maps a unique violation from a concurrent save to 409', async () => {
    respond = (op) =>
      op.kind === 'insert'
        ? { data: null, error: { message: 'duplicate', code: '23505' } }
        : { data: null, error: null }
    const res = await save(DRAFT)
    expect(res.status).toBe(409)
    expect(history.record).not.toHaveBeenCalled()
  })
})
