import { afterEach, describe, expect, it, vi } from 'vitest'
import { lastNDayKeys } from '@/lib/dashboard/date-utils'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  groups: [] as Record<string, unknown>[],
  queryError: null as Error | null,
  contexts: [] as unknown[],
  sql: [] as string[],
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => new Response(null, { status: 403 }),
}))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (context: unknown, operation: (tx: unknown) => unknown) => {
    h.contexts.push(context)
    return operation({
      $queryRaw: async (strings: TemplateStringsArray) => {
        h.sql.push(strings.join('?'))
        if (h.queryError) throw h.queryError
        return h.groups
      },
    })
  },
}))

import { GET } from './route'

const ADMIN = { accountId: 'account-1', userId: 'user-1', role: 'admin' }
const group = (day: string, mode: string, calls: number, total: number, model = 'gpt-x') =>
  ({ day, mode, provider: 'openai', model, calls, prompt_tokens: total - calls, completion_tokens: calls, total_tokens: total })

afterEach(() => { vi.clearAllMocks(); h.groups = []; h.queryError = null; h.contexts = []; h.sql = [] })

describe('GET /api/ai/usage', () => {
  it('is admin-only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await GET(new Request('https://crm.test/api/ai/usage'))).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })

  it('aggregates in SQL inside the workspace tenant, grouped by day, mode and model', async () => {
    h.requireRole.mockResolvedValue(ADMIN)
    await GET(new Request('https://crm.test/api/ai/usage?days=7'))
    expect(h.contexts).toEqual([{ accountId: 'account-1', userId: 'user-1', role: 'admin' }])
    expect(h.sql[0]).toMatch(/FROM ai_usage_log/)
    expect(h.sql[0]).toMatch(/GROUP BY/)
    expect(h.sql[0]).toMatch(/account_id = \?::uuid/)
  })

  it('counts every call of a busy window, the newest days included, with no partial-window flag', async () => {
    const days = lastNDayKeys(90)
    // 150 AI calls a day for 90 days: 13,500 calls, past the old 10,000-row cap.
    h.groups = days.map((day) => group(day, 'auto_reply', 150, 300))
    h.requireRole.mockResolvedValue(ADMIN)
    const response = await GET(new Request('https://crm.test/api/ai/usage?days=90'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.totals).toMatchObject({ calls: 13_500, total_tokens: 27_000, prompt_tokens: 13_500, completion_tokens: 13_500 })
    expect(body.daily).toHaveLength(90)
    expect(body.daily.at(-1)).toEqual({ date: days.at(-1), tokens: 300, calls: 150 })
    expect(body.daily[0]).toEqual({ date: days[0], tokens: 300, calls: 150 })
    expect(body).not.toHaveProperty('truncated')
  })

  it('reports every usage mode and model, skipping an unknown mode without throwing', async () => {
    const today = lastNDayKeys(1)[0]
    h.groups = [group(today, 'auto_reply', 1, 10), group(today, 'draft', 2, 20), group(today, 'summary', 1, 30), group(today, 'suggest', 1, 40),
      group(today, 'assess', 1, 50), group(today, 'insights', 1, 60, 'gpt-y'), group(today, 'legacy_unknown', 1, 5)]
    h.requireRole.mockResolvedValue(ADMIN)
    const body = await (await GET(new Request('https://crm.test/api/ai/usage?days=7'))).json()
    expect(body.by_mode).toEqual({
      auto_reply: { calls: 1, tokens: 10 }, draft: { calls: 2, tokens: 20 }, summary: { calls: 1, tokens: 30 },
      suggest: { calls: 1, tokens: 40 }, assess: { calls: 1, tokens: 50 }, insights: { calls: 1, tokens: 60 },
    })
    expect(body.by_model).toEqual([
      { model: 'gpt-x', provider: 'openai', calls: 7, tokens: 155 },
      { model: 'gpt-y', provider: 'openai', calls: 1, tokens: 60 },
    ])
    expect(body.totals.total_tokens).toBe(215)
  })

  it('answers 500 with a generic message when the query fails', async () => {
    h.queryError = new Error('relation missing: secret detail')
    h.requireRole.mockResolvedValue(ADMIN)
    const response = await GET(new Request('https://crm.test/api/ai/usage'))
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).not.toContain('secret detail')
  })
})
