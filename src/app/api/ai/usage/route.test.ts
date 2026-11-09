import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireRole: vi.fn(), rows: [] as Record<string, unknown>[] }))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => new Response(null, { status: 403 }),
}))

import { GET } from './route'

// Like the real data layer: at most 1000 rows per query (lib/data/contracts).
function db() {
  const chain = {
    select: () => chain, eq: () => chain, gte: () => chain, order: () => chain,
    range: async (from: number, to: number) => {
      if (to - from + 1 > 1000) return { data: null, error: { message: 'Pagination out of bounds' } }
      return { data: h.rows.slice(from, to + 1), error: null }
    },
  }
  return { from: () => chain }
}

afterEach(() => { vi.clearAllMocks(); h.rows = [] })

describe('GET /api/ai/usage', () => {
  it('is admin-only', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    expect((await GET(new Request('https://crm.test/api/ai/usage'))).status).toBe(403)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
  })

  it('reads a window larger than one 1000-row page, counting every row once', async () => {
    const now = new Date().toISOString()
    h.rows = Array.from({ length: 2500 }, () => ({ created_at: now, mode: 'auto_reply', provider: 'openai', model: 'gpt-x', prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }))
    h.requireRole.mockResolvedValue({ db: db(), accountId: 'account-1' })
    const response = await GET(new Request('https://crm.test/api/ai/usage?days=30'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.totals).toMatchObject({ calls: 2500, total_tokens: 5000 })
    expect(body.truncated).toBe(false)
  })

  it('reports every usage mode, including the phase 13 assistant modes, without throwing', async () => {
    const now = new Date().toISOString()
    const row = (mode: string, total: number) => ({ created_at: now, mode, provider: 'openai', model: 'gpt-x', prompt_tokens: total - 1, completion_tokens: 1, total_tokens: total })
    h.rows = [row('auto_reply', 10), row('draft', 20), row('summary', 30), row('suggest', 40), row('assess', 50), row('insights', 60), row('legacy_unknown', 5)]
    h.requireRole.mockResolvedValue({ db: db(), accountId: 'account-1' })
    const response = await GET(new Request('https://crm.test/api/ai/usage?days=7'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.by_mode).toEqual({
      auto_reply: { calls: 1, tokens: 10 }, draft: { calls: 1, tokens: 20 }, summary: { calls: 1, tokens: 30 },
      suggest: { calls: 1, tokens: 40 }, assess: { calls: 1, tokens: 50 }, insights: { calls: 1, tokens: 60 },
    })
    expect(body.totals.total_tokens).toBe(215)
  })
})
