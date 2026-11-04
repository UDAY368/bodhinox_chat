import { beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const CONV = '33333333-3333-4333-8333-333333333333'

const h = vi.hoisted(() => ({
  tenants: [] as Array<{ ctx: unknown; db: unknown }>,
  queries: [] as string[],
  retrieve: vi.fn(),
}))

vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown, db: unknown) => {
    h.tenants.push({ ctx, db })
    return fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?')
        h.queries.push(sql)
        if (sql.includes('SELECT id, contact_id, channel FROM conversations')) return values.includes(CONV) ? [{ id: CONV, contact_id: 'ct-1', channel: 'whatsapp' }] : []
        if (sql.includes('SELECT contact_id FROM conversations')) return [{ contact_id: 'ct-1' }]
        if (sql.includes('FROM messages')) return [
          { id: 'm2', sender_type: 'agent', content_type: 'image', content_text: null, interactive_payload: null, created_at: new Date('2026-11-04T10:01:00Z') },
          { id: 'm1', sender_type: 'customer', content_type: 'text', content_text: 'Hello there', interactive_payload: null, created_at: new Date('2026-11-04T10:00:00Z') },
        ]
        if (sql.includes('FROM contacts')) return [{ name: 'Asha', company: 'Acme' }]
        if (sql.includes('contact_tags')) return [{ name: 'VIP' }]
        if (sql.includes('FROM orders')) return [{ id: 'abcdef12-0000', status: 'paid', currency: 'INR', total_minor: BigInt(150000), subtotal_minor: BigInt(150000),
          paid_at: new Date('2026-11-01'), refund_state: 'none', dispatched_at: null, delivered_at: null, created_at: new Date('2026-11-01') }]
        return []
      },
    })
  },
}))
vi.mock('@/lib/db/prisma', () => ({ getPrisma: () => 'app', getWorkerPrisma: () => 'worker' }))
vi.mock('@/lib/data/server', () => ({ createScopedClient: (ctx: unknown) => ({ scoped: ctx }) }))
vi.mock('../admin-client', () => ({ databaseAdmin: (ctx: unknown) => ({ worker: ctx }) }))
vi.mock('../config', () => ({ loadEmbeddingsKey: async () => ({ key: null, corrupt: false }) }))
vi.mock('../knowledge', () => ({ retrieveKnowledgeScored: h.retrieve }))
vi.mock('@/lib/analytics/queries', () => ({ ANALYTICS_STATEMENT_TIMEOUT_MS: 15000 }))
vi.mock('@/lib/analytics/range', () => ({
  workspaceTimezone: async () => 'Asia/Kolkata',
  parseRange: (input: { from: string; to: string }) => ({ startDay: input.from, endDay: input.to }),
}))
vi.mock('../insights/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../insights/registry')>()
  return {
    ...actual,
    computeInsight: async () => ({ metrics: { assigned: 12 }, rowCount: 12,
      rows: [{ label: 'Agent 1', name: 'Priya Secret', values: { assigned: 12 } }] }),
  }
})

import { ContextAccessError, CONTEXT_PROVIDER_KEYS, getContextProvider, loadContext, type ContextRequest } from './index'

const staff: ContextRequest = { accountId: ACCOUNT, userId: USER, role: 'agent', audience: 'staff', conversationId: CONV, maxMessages: 10 }

beforeEach(() => {
  h.tenants = []
  h.queries = []
  h.retrieve.mockReset().mockResolvedValue({ chunks: [{ id: 'c1', content: 'Open 10-6', title: 'Hours' }], retrieval: null,
    citations: [{ chunk_id: 'c1', document_id: 'd1', source_id: null, title: 'Hours', source_url: null }] })
})

describe('context provider registry', () => {
  it('registers every provider, including insightData from the insights module', () => {
    for (const key of CONTEXT_PROVIDER_KEYS) expect(getContextProvider(key)).toBeDefined()
  })

  it('insightData is staff-only, checks the insight role and never returns agent names', async () => {
    const insight = { key: 'agent_workload', from: '2026-10-01', to: '2026-10-31' }
    await expect(loadContext(['insightData'], { ...staff, audience: 'customer', insight })).rejects.toMatchObject({ reason: 'audience' })
    const unknown = await loadContext(['insightData'], { ...staff, insight: { ...insight, key: 'raw_sql' } })
    expect(unknown.facts).toEqual({})
    const result = await loadContext(['insightData'], { ...staff, role: 'admin', insight })
    expect(result.facts).toMatchObject({ insight_key: 'agent_workload', row_count: 12, 'metric.assigned': 12, 'row.Agent 1.assigned': 12 })
    expect(JSON.stringify(result)).not.toContain('Priya')
  })

  it('refuses staff-only records for a customer-facing request', async () => {
    for (const key of ['orderStatus', 'appointmentStatus', 'openDeal'] as const) {
      await expect(loadContext([key], { ...staff, audience: 'customer' })).rejects.toBeInstanceOf(ContextAccessError)
    }
    expect(h.queries).toHaveLength(0)
  })

  it('refuses a viewer', async () => {
    await expect(loadContext(['conversation'], { ...staff, role: 'viewer' })).rejects.toMatchObject({ reason: 'role' })
  })

  it('runs as the member on the app role, or as the worker for a job', async () => {
    await loadContext(['conversation'], staff)
    expect(h.tenants[0]).toEqual({ ctx: { accountId: ACCOUNT, userId: USER, role: 'agent' }, db: 'app' })
    await loadContext(['conversation'], { ...staff, userId: null, role: 'owner' })
    expect(h.tenants[1]).toEqual({ ctx: { accountId: ACCOUNT, role: 'owner' }, db: 'worker' })
  })
})

describe('built-in providers', () => {
  it('conversation: visible text and media markers, message ids as evidence', async () => {
    const out = await loadContext(['conversation'], staff)
    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0]).toMatchObject({ source: 'customer', label: 'transcript' })
    expect(out.blocks[0].text).toContain('Customer: Hello there')
    expect(out.blocks[0].text).toContain('Staff: [image]')
    expect(out.sourceMessageIds).toEqual(['m1', 'm2'])
    expect(out.facts).toMatchObject({ message_count: 2, customer_message_count: 1 })
  })

  it('contactBasics: name, company and tags only, never phone or email', async () => {
    const out = await loadContext(['contactBasics'], staff)
    expect(out.blocks[0]).toMatchObject({ source: 'crm', text: 'Name: Asha\nCompany: Acme\nTags: VIP' })
    const contactSql = h.queries.find((q) => q.includes('FROM contacts') && q.includes('name'))!
    expect(contactSql).not.toMatch(/phone|email/)
  })

  it('orderStatus: statuses labelled as database records, for staff', async () => {
    const out = await loadContext(['orderStatus'], staff)
    expect(out.blocks[0].label).toContain('data from the database')
    expect(out.blocks[0].text).toContain('payment recorded 2026-11-01')
    expect(out.blocks[0].text).toContain('delivery not recorded')
  })

  it('knowledge: retrieves for the request audience with the member scope', async () => {
    const out = await loadContext(['knowledge'], { ...staff, audience: 'customer', query: 'hours?' })
    expect(h.retrieve).toHaveBeenCalledWith({ scoped: { accountId: ACCOUNT, userId: USER, role: 'agent' } }, ACCOUNT, { embeddingsApiKey: null }, 'hours?', 5, 'customer')
    expect(out.blocks[0]).toMatchObject({ source: 'knowledge', text: 'Open 10-6' })
    expect(out.citations).toHaveLength(1)
    await loadContext(['knowledge'], { ...staff, query: '   ' })
    expect(h.retrieve).toHaveBeenCalledTimes(1)
  })

  it('a conversation outside the workspace yields no context', async () => {
    const out = await loadContext(['conversation'], { ...staff, conversationId: '99999999-9999-4999-8999-999999999999' })
    expect(out.blocks).toHaveLength(0)
  })
})
