import { beforeEach, describe, expect, it, vi } from 'vitest'

// recordTemplateEvents batches into bounded withTenant transactions. Here
// withTenant hands each chunk a fake transaction so the chunking, the
// latest-event comparison and the deleted-template skip are checked
// without a database; template-events.integration.test.ts runs the same
// path against PostgreSQL.

const db = vi.hoisted(() => ({
  transactions: 0,
  failOn: new Set<number>(),
  templates: new Set<string>(),
  latest: new Map<string, { status: string; reason: string | null; quality_score: string | null }>(),
  created: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/db/prisma', () => ({ getPrisma: () => ({}), getWorkerPrisma: () => ({}) }))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => Promise<unknown>) => {
    const n = ++db.transactions
    if (db.failOn.has(n)) throw new Error('transaction timeout')
    return op({
      message_templates: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => db.templates.has(id)).map((id) => ({ id })),
      },
      $queryRaw: async (_s: TemplateStringsArray, _acct: string, ids: string[]) =>
        ids.filter((id) => db.latest.has(id)).map((id) => ({ template_id: id, ...db.latest.get(id)! })),
      template_status_events: {
        createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
          db.created.push(...data)
          return { count: data.length }
        },
      },
    })
  },
}))

import {
  TEMPLATE_EVENTS_CHUNK,
  normalizeRejectionReason,
  recordTemplateEvents,
} from './template-events'

const ACCOUNT = '00000000-0000-4000-8000-000000000001'
const ctx = { accountId: ACCOUNT, role: 'admin' as const }
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

beforeEach(() => {
  db.transactions = 0
  db.failOn.clear()
  db.templates.clear()
  db.latest.clear()
  db.created.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('normalizeRejectionReason', () => {
  it('keeps a real reason only on REJECTED', () => {
    expect(normalizeRejectionReason('REJECTED', 'INVALID_FORMAT')).toBe('INVALID_FORMAT')
    expect(normalizeRejectionReason('APPROVED', 'INVALID_FORMAT')).toBeNull()
  })
  it.each([undefined, null, '', '  ', 'NONE', 'none', 42])('treats %j as no reason', (raw) => {
    expect(normalizeRejectionReason('REJECTED', raw)).toBeNull()
  })
})

describe('recordTemplateEvents chunking', () => {
  it('splits a large catalog into bounded transactions', async () => {
    const total = TEMPLATE_EVENTS_CHUNK * 2 + 7
    for (let i = 1; i <= total; i++) db.templates.add(id(i))
    const events = Array.from({ length: total }, (_, i) => ({
      templateId: id(i + 1), status: 'APPROVED', source: 'sync' as const,
    }))
    expect(await recordTemplateEvents(ctx, events)).toBe(total)
    expect(db.transactions).toBe(3)
  })

  it('loses only the failed chunk when one transaction fails', async () => {
    const total = TEMPLATE_EVENTS_CHUNK * 3
    for (let i = 1; i <= total; i++) db.templates.add(id(i))
    db.failOn.add(2)
    const events = Array.from({ length: total }, (_, i) => ({
      templateId: id(i + 1), status: 'APPROVED', source: 'sync' as const,
    }))
    expect(await recordTemplateEvents(ctx, events)).toBe(TEMPLATE_EVENTS_CHUNK * 2)
    const recorded = new Set(db.created.map((r) => r.template_id))
    expect(recorded.has(id(1))).toBe(true)
    expect(recorded.has(id(TEMPLATE_EVENTS_CHUNK + 1))).toBe(false)
    expect(recorded.has(id(total))).toBe(true)
    // The log carries the error class only, never template content.
    expect(console.error).toHaveBeenCalledWith('[template-events] failed to record status history', 'Error')
  })

  it('skips templates deleted before the history write instead of failing the chunk', async () => {
    db.templates.add(id(1))
    const n = await recordTemplateEvents(ctx, [
      { templateId: id(1), status: 'APPROVED', source: 'sync' },
      { templateId: id(2), status: 'APPROVED', source: 'sync' },
    ])
    expect(n).toBe(1)
    expect(db.created.map((r) => r.template_id)).toEqual([id(1)])
  })

  it('skips templates whose state matches their latest event and carries the score forward', async () => {
    db.templates.add(id(1)).add(id(2))
    db.latest.set(id(1), { status: 'REJECTED', reason: null, quality_score: null })
    db.latest.set(id(2), { status: 'APPROVED', reason: null, quality_score: 'GREEN' })
    const n = await recordTemplateEvents(ctx, [
      { templateId: id(1), status: 'REJECTED', reason: normalizeRejectionReason('REJECTED', 'NONE'), source: 'sync' },
      { templateId: id(2), status: 'PAUSED', source: 'sync' },
    ])
    expect(n).toBe(1)
    expect(db.created).toEqual([
      { account_id: ACCOUNT, template_id: id(2), status: 'PAUSED', reason: null, quality_score: 'GREEN', source: 'sync' },
    ])
  })
})
