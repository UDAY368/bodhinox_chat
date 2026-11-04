import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const SOURCE = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  source: null as null | Record<string, unknown>,
  unsafe: [] as { sql: string; values: unknown[] }[],
  raw: [] as { sql: string; values: unknown[] }[],
}))

const sqlOf = (q: unknown) => (Array.isArray(q) ? (q as string[]).join('?') : String(q))
const tx = {
  async $queryRawUnsafe(sql: string, ...v: unknown[]) {
    h.unsafe.push({ sql, values: v })
    if (sql.startsWith('SELECT') && sql.includes('FROM ai_knowledge_sources WHERE account_id=$1::uuid AND id=')) return h.source ? [h.source] : []
    if (sql.startsWith('SELECT')) return h.source ? [h.source] : []
    if (sql.startsWith('UPDATE ai_knowledge_sources SET min_role')) {
      h.source = { ...h.source, min_role: v[2], customer_facing: v[3] }
      return [h.source]
    }
    if (sql.startsWith('INSERT INTO ai_knowledge_sources')) {
      h.source = { ...base(), kind: v[1], min_role: v[7], customer_facing: v[8] }
      return [h.source]
    }
    throw new Error(`unexpected unsafe query: ${sql}`)
  },
  async $queryRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    h.raw.push({ sql: sqlOf(strings), values: v })
    if (sqlOf(strings).includes('count(*)::int AS n')) return [{ n: 0 }]
    return []
  },
  async $executeRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    h.raw.push({ sql: sqlOf(strings), values: v })
    return 1
  },
}

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) }))

import {
  KnowledgeSourceError, listSources, getSource, parseAccessPatch, parseSourceInput, resolveAccess, updateSourceAccess, createSource,
} from './knowledge-sources'

const base = () => ({
  id: SOURCE, kind: 'website', url: 'https://example.com/', title: 'Site', status: 'ready', page_limit: 50, pages_indexed: 3,
  last_crawled_at: null, error: null, min_role: 'agent', customer_facing: true, created_by: USER, current_run_id: null,
  created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'),
})
const admin = { accountId: ACCOUNT, userId: USER, role: 'admin' as const }
const agent = { ...admin, role: 'agent' as const }
const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof KnowledgeSourceError ? e.code : String(e) } }
const audits = () => h.raw.filter((s) => s.sql.includes("'ai.knowledge_access_updated'"))

beforeEach(() => {
  h.source = base()
  h.unsafe = []
  h.raw = []
})

describe('knowledge source access', () => {
  it('defaults to agents and customer replies; admin-only turns customer use off; the invalid pair is refused', () => {
    expect(resolveAccess({})).toEqual({ min_role: 'agent', customer_facing: true })
    expect(resolveAccess({ min_role: 'admin' })).toEqual({ min_role: 'admin', customer_facing: false })
    expect(resolveAccess({ customer_facing: false })).toEqual({ min_role: 'agent', customer_facing: false })
    expect(() => resolveAccess({ min_role: 'admin', customer_facing: true })).toThrow(KnowledgeSourceError)
    expect(() => parseSourceInput({ kind: 'text', title: 'a', content: 'b', min_role: 'admin', customer_facing: true })).toThrow(KnowledgeSourceError)
  })

  it('parses a PATCH body strictly', () => {
    expect(parseAccessPatch({ min_role: 'admin' })).toEqual({ min_role: 'admin' })
    for (const bad of [null, {}, { min_role: 'viewer' }, { min_role: 'owner' }, { customer_facing: 1 }, { min_role: 'agent', title: 'x' }])
      expect(() => parseAccessPatch(bad)).toThrow(KnowledgeSourceError)
  })

  it('makes a source admin-only, turning customer use off, and audits it', async () => {
    const source = await updateSourceAccess(admin, SOURCE, { min_role: 'admin' })
    expect(source).toMatchObject({ min_role: 'admin', customer_facing: false })
    expect(audits()).toHaveLength(1)
    expect(audits()[0].values).toContain(JSON.stringify({ min_role: 'admin', customer_facing: false }))
  })

  it('refuses customer use for an admin-only source, and changes nothing when nothing changes', async () => {
    h.source = { ...base(), min_role: 'admin', customer_facing: false }
    expect(await code(updateSourceAccess(admin, SOURCE, { customer_facing: true }))).toBe('invalid_input')
    expect(await updateSourceAccess(admin, SOURCE, { min_role: 'admin' })).toMatchObject({ min_role: 'admin' })
    expect(h.unsafe.some((q) => q.sql.startsWith('UPDATE'))).toBe(false)
    expect(audits()).toHaveLength(0)
  })

  it('refuses below admin, malformed ids and missing sources', async () => {
    expect(await code(updateSourceAccess(agent, SOURCE, { min_role: 'admin' }))).toBe('forbidden')
    expect(await code(updateSourceAccess(admin, 'nope', { min_role: 'admin' }))).toBe('not_found')
    h.source = null
    expect(await code(updateSourceAccess(admin, SOURCE, { min_role: 'admin' }))).toBe('not_found')
  })

  it('hides admin-only sources below admin, in the list and by id', async () => {
    await listSources(agent)
    expect(h.unsafe[0].sql).toContain("AND min_role = 'agent'")
    await listSources(admin)
    expect(h.unsafe[1].sql).not.toContain('min_role =')
    h.source = { ...base(), min_role: 'admin', customer_facing: false }
    expect(await getSource(agent, SOURCE)).toBeNull()
    expect(await getSource(admin, SOURCE)).not.toBeNull()
  })

  it('stores the chosen access on a new source and audits only an explicit choice', async () => {
    const created = await createSource(admin, parseSourceInput({ kind: 'website', url: 'https://example.com', min_role: 'admin' }))
    expect(created).toMatchObject({ min_role: 'admin', customer_facing: false })
    expect(audits()).toHaveLength(1)
    h.raw = []
    const plain = await createSource(admin, parseSourceInput({ kind: 'website', url: 'https://example.com' }))
    expect(plain).toMatchObject({ min_role: 'agent', customer_facing: true })
    expect(audits()).toHaveLength(0)
  })
})
