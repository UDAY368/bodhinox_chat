import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  enabled: true,
  pending: 0,
  statements: [] as { sql: string; values: unknown[] }[],
  contexts: [] as unknown[],
}))

const sqlOf = (q: unknown) => (Array.isArray(q) ? (q as string[]).join('?') : String(q))
const row = {
  id: RUN, insight_key: 'conversation_volume', range_from: '2026-10-06', range_to: '2026-11-04', status: 'queued',
  data: null, coverage: null, caveats: [], uncertainty: null, narrative: null, narrative_source: null, guard_flags: [],
  source_links: [{ key: 'x', href: 'https://evil.example/' }, { key: 'conversation_volume', href: '/analytics' }],
  error_code: null, requested_by: USER, created_at: new Date('2026-11-04T10:00:00Z'), completed_at: null,
}
const tx = {
  async $queryRaw(strings: TemplateStringsArray | { strings: string[] }, ...v: unknown[]) {
    const sql = 'strings' in strings ? strings.strings.join('?') : sqlOf(strings)
    h.statements.push({ sql, values: v })
    if (sql.includes('count(*)::int AS n FROM ai_insight_runs')) return [{ n: h.pending }]
    if (sql.includes('INSERT INTO ai_insight_runs')) return [{ id: RUN }]
    if (sql.includes('FROM ai_insight_runs')) return [row]
    throw new Error(`unexpected query: ${sql}`)
  },
  async $executeRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    h.statements.push({ sql: sqlOf(strings), values: v })
    return 1
  },
}

vi.mock('@/lib/db/tenant', () => ({ withTenant: async (c: unknown, fn: (t: unknown) => unknown) => { h.contexts.push(c); return fn(tx) } }))
vi.mock('@/lib/ai/settings', () => ({ readAiSettings: async () => ({ insights_enabled: h.enabled }) }))
vi.mock('@/lib/analytics/range', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/range')>()),
  workspaceTimezone: async () => 'Asia/Kolkata',
}))

import { getInsightRun, InsightError, MAX_PENDING_INSIGHTS, requestInsight } from './runs'

const actor = { accountId: ACCOUNT, userId: USER, role: 'agent' as const }

beforeEach(() => {
  h.enabled = true
  h.pending = 0
  h.statements = []
  h.contexts = []
})

const code = async (p: Promise<unknown>) => { try { await p; return null } catch (e) { return e instanceof InsightError ? e.code : String(e) } }

describe('requestInsight', () => {
  it('records the run and queues its job in the same transaction, then audits', async () => {
    const run = await requestInsight(actor, { key: 'conversation_volume', range: { preset: '30d' } })
    expect(run).toMatchObject({ id: RUN, key: 'conversation_volume', status: 'queued', mine: true })
    // Only same-site source links survive.
    expect(run.sourceLinks).toEqual([{ key: 'conversation_volume', href: '/analytics' }])
    const sqls = h.statements.map((s) => s.sql)
    const lock = sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'))
    const insert = sqls.findIndex((s) => s.includes('INSERT INTO ai_insight_runs'))
    const job = h.statements.find((s) => s.sql.includes('INSERT INTO jobs'))!
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(insert).toBeGreaterThan(lock)
    expect(job.values).toEqual(['ai.insight_run', ACCOUNT, JSON.stringify({ runId: RUN }), `ai-insight:${RUN}`, 2])
    expect(sqls.some((s) => s.includes("'ai.insight_requested'"))).toBe(true)
    expect(h.contexts).toHaveLength(1)
    expect(h.contexts[0]).toEqual(actor)
  })

  it('refuses unknown keys, viewers, a switched-off workspace, bad ranges and a full queue', async () => {
    expect(await code(requestInsight(actor, { key: 'everything', range: {} }))).toBe('invalid_key')
    expect(await code(requestInsight({ ...actor, role: 'viewer' }, { key: 'conversation_volume', range: {} }))).toBe('forbidden')
    h.enabled = false
    expect(await code(requestInsight(actor, { key: 'conversation_volume', range: {} }))).toBe('feature_off')
    h.enabled = true
    expect(await code(requestInsight(actor, { key: 'conversation_volume', range: { preset: 'forever' } }))).toBe('invalid_range')
    h.pending = MAX_PENDING_INSIGHTS
    expect(await code(requestInsight(actor, { key: 'conversation_volume', range: {} }))).toBe('too_many_pending')
    expect(h.statements.some((s) => s.sql.includes('INSERT INTO jobs'))).toBe(false)
  })

  it('reads one run by id, refusing malformed ids without a query', async () => {
    expect(await code(getInsightRun(actor, 'x'))).toBe('not_found')
    expect(h.statements).toHaveLength(0)
    expect((await getInsightRun(actor, RUN)).id).toBe(RUN)
  })
})
