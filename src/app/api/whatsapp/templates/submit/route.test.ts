vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: 'user-1', accountId: ACCOUNT, role: callerRole, sessionId: 'session-1' }) }));
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Submit: kinds reach Meta with their card handles, a saved draft is
// submitted in place by id, and each persisted outcome records a
// 'submit' status event.

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const DRAFT_ID = '3f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const ROW_ID = '5f1c9d2e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
let callerRole = 'admin'

interface Op { table: string; kind: string; values?: Record<string, unknown>; filters: [string, unknown][] }
const ops: Op[] = []
let draftRow: { id: string; meta_template_id: string | null } | null = null
let clashRow: { id: string; meta_template_id?: string | null } | null = null
// Simulates a concurrent submit linking the row between the read and the write.
let linkedBeforeWrite = false
// The workspace's numbers; one by default, as before multi-number.
const NUMBER_A = '22222222-2222-4222-8222-222222222222'
const NUMBER_B = '33333333-3333-4333-8333-333333333333'
let numbers: Record<string, unknown>[] = []

function makeDb() {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
    from(table: string) {
      const op: Op = { table, kind: 'select', filters: [] }
      ops.push(op)
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn((f: string, v: unknown) => { op.filters.push([f, v]); return b })
      b.is = vi.fn((f: string, v: unknown) => { op.filters.push([`is:${f}`, v]); return b })
      b.insert = vi.fn((v: Record<string, unknown>) => { op.kind = 'insert'; op.values = v; return b })
      b.update = vi.fn((v: Record<string, unknown>) => { op.kind = 'update'; op.values = v; return b })
      b.upsert = vi.fn((v: Record<string, unknown>) => { op.kind = 'upsert'; op.values = v; return b })
      const result = async () => {
        if (table === 'accounts') return { data: { id: ACCOUNT, name: 'Acme' }, error: null }
        if (table === 'whatsapp_config') {
          return { data: { waba_id: 'WABA-1', access_token: 'enc' }, error: null }
        }
        if (op.kind === 'select') {
          return op.filters.some(([f]) => f === 'id')
            ? { data: draftRow, error: null }
            : { data: clashRow, error: null }
        }
        if (op.kind === 'update' && linkedBeforeWrite && op.filters.some(([f]) => f === 'is:meta_template_id')) {
          return { data: null, error: null }
        }
        return { data: { ...op.values, id: op.kind === 'update' ? DRAFT_ID : ROW_ID }, error: null }
      }
      b.single = vi.fn(result)
      b.maybeSingle = vi.fn(async () => {
        if (table !== 'whatsapp_config') return result()
        const id = op.filters.find(([f]) => f === 'id')?.[1]
        return { data: numbers.find((row) => row.id === id) ?? null, error: null }
      })
      if (table === 'whatsapp_config') {
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: numbers, error: null })
      }
      return b
    },
  }
}
vi.mock('@/lib/data/server', () => ({ createClient: vi.fn(async () => makeDb()) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: vi.fn(() => 'plaintext-token') }))

const meta = vi.hoisted(() => ({ submit: vi.fn<(...args: unknown[]) => Promise<{ id: string; status: string }>>(async () => ({ id: 'meta-9', status: 'PENDING' })) }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ submitMessageTemplate: meta.submit }))

const media = vi.hoisted(() => ({
  header: vi.fn(async () => undefined),
  cards: vi.fn(async (payload: { cards?: { header_handle?: string }[] }) => {
    for (const card of payload.cards ?? []) card.header_handle = 'h-card'
  }),
}))
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureMediaHeaderHandle: media.header,
  ensureCarouselCardHandles: media.cards,
}))

const history = vi.hoisted(() => ({ record: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1) }))
vi.mock('@/lib/whatsapp/template-events', () => ({ recordTemplateEvents: history.record }))

// Feature permissions are covered in src/lib/auth/permissions.test.ts; allowed here.
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => undefined }));
import { POST } from './route'

const submit = (body: Record<string, unknown>) =>
  POST(
    new Request('http://localhost/api/whatsapp/templates/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const card = (n: number) => ({
  header_type: 'image',
  header_media_url: `https://cdn.example/${n}.jpg`,
  body_text: `Card ${n}`,
  buttons: [{ type: 'QUICK_REPLY', text: 'Buy' }],
})
const CAROUSEL = {
  name: 'weekly_picks',
  category: 'Marketing',
  language: 'en_US',
  template_kind: 'carousel',
  body_text: 'Our picks for you',
  cards: [card(1), card(2)],
}
const AUTH = {
  name: 'login_code',
  category: 'Authentication',
  language: 'en_US',
  template_kind: 'authentication',
  body_text: '',
  auth_options: { otp_type: 'COPY_CODE', code_expiration_minutes: 10 },
}

beforeEach(() => {
  ops.length = 0
  callerRole = 'admin'
  draftRow = null
  clashRow = null
  linkedBeforeWrite = false
  numbers = [{ id: NUMBER_A, waba_id: 'WABA-1', access_token: 'enc', is_default: true, created_at: '2026-01-01T00:00:00Z' }]
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN
  meta.submit.mockClear()
  media.cards.mockClear()
  history.record.mockClear()
})

describe('POST /api/whatsapp/templates/submit', () => {
  it('uploads card handles before building the carousel for Meta and stores the kind', async () => {
    const res = await submit(CAROUSEL)
    expect(res.status).toBe(200)
    expect(media.cards).toHaveBeenCalledTimes(1)
    const sent = JSON.stringify(meta.submit.mock.calls[0])
    expect(sent).toContain('CAROUSEL')
    expect(sent).toContain('h-card')
    const insert = ops.find((o) => o.kind === 'insert')!
    expect(insert.values).toMatchObject({ template_kind: 'carousel', status: 'PENDING', meta_template_id: 'meta-9' })
    expect((insert.values!.cards as unknown[]).length).toBe(2)
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT }),
      [{ templateId: ROW_ID, status: 'PENDING', source: 'submit' }],
    )
  })

  it('accepts the Authentication category only as the authentication kind', async () => {
    expect((await submit(AUTH)).status).toBe(200)
    const legacy = await submit({ ...AUTH, template_kind: 'standard', auth_options: null, body_text: 'Code {{1}}' })
    expect(legacy.status).toBe(400)
    expect(meta.submit).toHaveBeenCalledTimes(1)
  })

  it('submits a saved draft in place by id', async () => {
    draftRow = { id: DRAFT_ID, meta_template_id: null }
    clashRow = { id: DRAFT_ID }
    const res = await submit({ ...CAROUSEL, id: DRAFT_ID })
    expect(res.status).toBe(200)
    expect(ops.some((o) => o.kind === 'upsert')).toBe(false)
    const update = ops.find((o) => o.kind === 'update')!
    expect(update.filters).toEqual([['id', DRAFT_ID], ['account_id', ACCOUNT], ['is:meta_template_id', null]])
    expect(update.values).not.toHaveProperty('id')
    expect(history.record.mock.calls[0][1]).toEqual([
      { templateId: DRAFT_ID, status: 'PENDING', source: 'submit' },
    ])
  })

  it('refuses a draft id that already reached Meta, or one outside the account', async () => {
    draftRow = { id: DRAFT_ID, meta_template_id: 'meta-1' }
    expect((await submit({ ...CAROUSEL, id: DRAFT_ID })).status).toBe(409)
    draftRow = null
    expect((await submit({ ...CAROUSEL, id: DRAFT_ID })).status).toBe(404)
    expect((await submit({ ...CAROUSEL, id: 'not-a-uuid' })).status).toBe(400)
    expect(meta.submit).not.toHaveBeenCalled()
  })

  it('refuses to rename a draft onto another template before calling Meta', async () => {
    draftRow = { id: DRAFT_ID, meta_template_id: null }
    clashRow = { id: ROW_ID }
    expect((await submit({ ...CAROUSEL, id: DRAFT_ID })).status).toBe(409)
    expect(meta.submit).not.toHaveBeenCalled()
  })

  it('keeps a failed submit as DRAFT and records the Meta error as the reason', async () => {
    meta.submit.mockRejectedValueOnce(new Error('Invalid parameter'))
    const res = await submit(CAROUSEL)
    expect(res.status).toBe(502)
    expect(ops.find((o) => o.kind === 'insert')!.values).toMatchObject({
      status: 'DRAFT',
      submission_error: 'Invalid parameter',
    })
    expect(history.record.mock.calls[0][1]).toEqual([
      { templateId: ROW_ID, status: 'DRAFT', reason: 'Invalid parameter', source: 'submit' },
    ])
  })

  it('R0/R3: a failed submit never unlinks a draft another submit already sent to Meta', async () => {
    draftRow = { id: DRAFT_ID, meta_template_id: null }
    linkedBeforeWrite = true
    meta.submit.mockRejectedValueOnce(new Error('Content in this language already exists'))
    const res = await submit({ ...CAROUSEL, id: DRAFT_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ meta_error: 'Content in this language already exists' })
    const update = ops.find((o) => o.kind === 'update')!
    expect(update.filters).toContainEqual(['is:meta_template_id', null])
    expect(history.record).not.toHaveBeenCalled()
  })

  it('R0/R3: a successful submit that lost the race keeps the existing link and returns its Meta id', async () => {
    draftRow = { id: DRAFT_ID, meta_template_id: null }
    linkedBeforeWrite = true
    const res = await submit({ ...CAROUSEL, id: DRAFT_ID })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ meta_template_id: 'meta-9' })
    expect(history.record).not.toHaveBeenCalled()
  })

  it('R4: a new submit onto a submitted template name is refused before Meta, with no write', async () => {
    clashRow = { id: ROW_ID, meta_template_id: '123' }
    const res = await submit(CAROUSEL)
    expect(res.status).toBe(409)
    expect(meta.submit).not.toHaveBeenCalled()
    expect(ops.some((o) => ['insert', 'update', 'upsert'].includes(o.kind))).toBe(false)
    expect(history.record).not.toHaveBeenCalled()
  })

  it('R4: a new submit onto an unsubmitted row with that name updates it by id, guarded', async () => {
    clashRow = { id: DRAFT_ID, meta_template_id: null }
    meta.submit.mockRejectedValueOnce(new Error('Invalid parameter'))
    expect((await submit(CAROUSEL)).status).toBe(502)
    expect(ops.some((o) => o.kind === 'upsert' || o.kind === 'insert')).toBe(false)
    const update = ops.find((o) => o.kind === 'update')!
    expect(update.filters).toEqual([['id', DRAFT_ID], ['account_id', ACCOUNT], ['is:meta_template_id', null]])
  })

  it('refuses agents before any Meta call', async () => {
    callerRole = 'agent'
    expect((await submit(CAROUSEL)).status).toBe(403)
    expect(meta.submit).not.toHaveBeenCalled()
    expect(history.record).not.toHaveBeenCalled()
  })

  it('stamps the WABA of the number it submitted to', async () => {
    expect((await submit(CAROUSEL)).status).toBe(200)
    expect(meta.submit.mock.calls[0][0]).toMatchObject({ wabaId: 'WABA-1' })
    expect(ops.find((o) => o.kind === 'insert')!.values).toMatchObject({ waba_id: 'WABA-1' })
  })
})

describe('POST /api/whatsapp/templates/submit — two numbers', () => {
  beforeEach(() => {
    numbers = [
      { id: NUMBER_A, waba_id: 'WABA-1', access_token: 'enc', is_default: true, created_at: '2026-01-01T00:00:00Z' },
      { id: NUMBER_B, waba_id: 'WABA-2', access_token: 'enc', is_default: false, created_at: '2026-02-01T00:00:00Z' },
    ]
  })

  it('submits to the default number without a choice instead of failing on two rows', async () => {
    expect((await submit(CAROUSEL)).status).toBe(200)
    expect(meta.submit.mock.calls[0][0]).toMatchObject({ wabaId: 'WABA-1' })
  })

  it('submits to the chosen number and stamps its WABA, without sending the choice to Meta', async () => {
    expect((await submit({ ...CAROUSEL, whatsapp_config_id: NUMBER_B })).status).toBe(200)
    expect(meta.submit.mock.calls[0][0]).toMatchObject({ wabaId: 'WABA-2' })
    expect(JSON.stringify(meta.submit.mock.calls[0][0])).not.toContain(NUMBER_B)
    expect(ops.find((o) => o.kind === 'insert')!.values).toMatchObject({ waba_id: 'WABA-2' })
  })

  it('refuses a number outside the workspace before Meta', async () => {
    const res = await submit({ ...CAROUSEL, whatsapp_config_id: '44444444-4444-4444-8444-444444444444' })
    expect(res.status).toBe(400)
    expect(meta.submit).not.toHaveBeenCalled()
    expect((await submit({ ...CAROUSEL, whatsapp_config_id: 'nope' })).status).toBe(400)
  })

  it('refuses a disconnected number with 409 before Meta', async () => {
    numbers = numbers.map((row) => row.id === NUMBER_B ? { ...row, status: 'disconnected', access_token: '' } : row)
    const res = await submit({ ...CAROUSEL, whatsapp_config_id: NUMBER_B })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'whatsapp_number_disconnected', error: expect.any(String) })
    expect(meta.submit).not.toHaveBeenCalled()
  })

  it('asks for a number when the workspace has several and no default', async () => {
    numbers = numbers.map((row) => ({ ...row, is_default: false }))
    expect((await submit(CAROUSEL)).status).toBe(400)
    expect(meta.submit).not.toHaveBeenCalled()
  })
})
