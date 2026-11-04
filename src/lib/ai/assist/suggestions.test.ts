import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as { text: string | null } | null,
  updated: true,
  calls: [] as Array<{ sql: string; values: unknown[] }>,
  tenant: null as unknown,
}))

const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    h.calls.push({ sql, values })
    if (sql.startsWith('\n      SELECT output') || sql.includes("SELECT output->>'text'")) return h.row ? [h.row] : []
    if (sql.includes('UPDATE ai_suggestions')) return h.updated ? [{ id: 'x' }] : []
    if (sql.includes('SELECT status FROM ai_suggestions')) return h.row ? [{ status: 'accepted' }] : []
    return []
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => { h.calls.push({ sql: strings.join('?'), values }); return 1 },
}
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (ctx: unknown, fn: (t: unknown) => unknown) => { h.tenant = ctx; return fn(tx) } }))

import { normalizedEditDistance, recordSuggestionUse, rejectSuggestion } from './suggestions'

const tenant = { accountId: 'acct-1', userId: 'user-1', role: 'agent' as const }
const use = { suggestionId: 's-1', conversationId: 'c-1', messageId: 'm-1', sentText: 'We open at 10.' }

beforeEach(() => {
  h.row = { text: 'We open at 10.' }
  h.updated = true
  h.calls = []
})

describe('normalizedEditDistance', () => {
  it('is 0 for the same text, 1000 for completely different text, and bounded in between', () => {
    expect(normalizedEditDistance('Hello', ' Hello ')).toBe(0)
    expect(normalizedEditDistance('abc', 'xyz')).toBe(1000)
    expect(normalizedEditDistance('We open at 10.', 'We open at 11.')).toBe(71)
    expect(normalizedEditDistance('', '')).toBe(0)
    const long = 'a'.repeat(5000)
    expect(normalizedEditDistance(long, long + 'b')).toBe(0) // compared over the first 2k characters
  })
})

describe('recordSuggestionUse', () => {
  it('marks an unchanged send accepted, links the message and audits it as the sender', async () => {
    expect(await recordSuggestionUse(tenant, use)).toEqual({ status: 'accepted', editDistance: 0 })
    expect(h.tenant).toBe(tenant)
    const update = h.calls.find((c) => c.sql.includes('UPDATE ai_suggestions'))!
    expect(update.sql).toContain("kind='reply' AND status='shown'")
    expect(update.values).toEqual(expect.arrayContaining(['accepted', 'm-1', 0, 'user-1', 'acct-1', 's-1', 'c-1']))
    const audit = h.calls.find((c) => c.sql.includes('audit_logs'))!
    expect(audit.sql).toContain("'ai.suggestion_used'")
    expect(JSON.stringify(audit.values)).not.toContain('We open')
  })

  it('marks an edited send edited with its distance', async () => {
    expect(await recordSuggestionUse(tenant, { ...use, sentText: 'We open at 11, see you!' })).toMatchObject({ status: 'edited' })
  })

  it('records nothing for a suggestion that is not a shown reply of this conversation', async () => {
    h.row = null
    expect(await recordSuggestionUse(tenant, use)).toBeNull()
    expect(h.calls.some((c) => c.sql.includes('UPDATE'))).toBe(false)
  })

  it('records nothing when another send used it first', async () => {
    h.updated = false
    expect(await recordSuggestionUse(tenant, use)).toBeNull()
    expect(h.calls.some((c) => c.sql.includes('audit_logs'))).toBe(false)
  })
})

describe('rejectSuggestion', () => {
  it('rejects a shown suggestion as the member', async () => {
    expect(await rejectSuggestion(tx as never, { accountId: 'acct-1', userId: 'user-1' }, 's-1')).toBe('ok')
    expect(h.calls[0].sql).toContain("status='rejected'")
    expect(h.calls[0].sql).toContain("status='shown'")
  })

  it('tells a decided suggestion from a missing one', async () => {
    h.updated = false
    expect(await rejectSuggestion(tx as never, { accountId: 'acct-1', userId: 'user-1' }, 's-1')).toBe('already_decided')
    h.row = null
    expect(await rejectSuggestion(tx as never, { accountId: 'acct-1', userId: 'user-1' }, 's-1')).toBe('not_found')
  })
})
