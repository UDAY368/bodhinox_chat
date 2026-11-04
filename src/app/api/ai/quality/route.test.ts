import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
  queryRaw: vi.fn(),
  aiTokensUsed: vi.fn(),
  tenants: [] as unknown[],
}))
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}))
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (c: unknown, fn: (tx: unknown) => unknown) => { h.tenants.push(c); return fn({ $queryRaw: h.queryRaw }) },
}))
vi.mock('@/lib/billing/limits', () => ({ aiTokensUsed: h.aiTokensUsed }))

import { GET } from './route'

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' }
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?')

function answer(counts: object | undefined, flags: object[] = [], sources: object[] = []) {
  h.queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    if (sql.includes('unnest(s.guard_flags)')) return flags
    if (sql.includes('FROM ai_assessments')) return sources
    return counts ? [counts] : []
  })
}

beforeEach(() => {
  h.requireRole.mockResolvedValue(ctx)
  h.requirePermission.mockResolvedValue(undefined)
  h.aiTokensUsed.mockResolvedValue(1234)
  h.tenants.length = 0
})
afterEach(() => vi.clearAllMocks())

describe('GET /api/ai/quality', () => {
  it('needs an admin with ai.settings and reads inside the caller tenant', async () => {
    answer({ replies: 0, accepted: 0, edited: 0, rejected: 0, summaries: 0, routed: 0, median_edit: null })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(h.requireRole).toHaveBeenCalledWith('admin')
    expect(h.requirePermission).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'admin' }, 'ai.settings')
    expect(h.tenants).toEqual([{ accountId: ctx.accountId, userId: ctx.userId, role: 'admin' }])
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    // Every query is scoped to the caller's workspace and the 30-day window.
    for (const call of h.queryRaw.mock.calls) {
      expect(sqlOf(call)).toContain('account_id=?::uuid')
      expect(call[1]).toBe(ctx.accountId)
    }
  })

  it('refuses agents and restricted admins without reading anything', async () => {
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    h.requirePermission.mockRejectedValueOnce(Object.assign(new Error('restricted'), { status: 403 }))
    expect((await GET()).status).toBe(403)
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('auth'), { status: 401 }))
    expect((await GET()).status).toBe(401)
    expect(h.queryRaw).not.toHaveBeenCalled()
  })

  it('computes rates over every reply shown, the median edit distance and flag counts', async () => {
    answer({ replies: 10, accepted: 4, edited: 3, rejected: 1, summaries: 6, routed: 2, median_edit: 120.4 },
      [{ flag: 'pii_redacted', count: 5 }, { flag: 'url_stripped', count: 1 }, { flag: 'bad flag <b>', count: 9 }],
      [{ source: 'model', count: 7 }, { source: 'deterministic', count: 3 }])
    const body = await (await GET()).json()
    expect(body).toEqual({
      window_days: 30,
      replies: { total: 10, accepted: 4, edited: 3, rejected: 1, ignored: 2, acceptance_rate: 0.4, edit_rate: 0.3, rejection_rate: 0.1, median_edit_distance: 120 },
      summaries: 6, routed_to_staff: 2,
      guard_flags: [{ flag: 'pii_redacted', count: 5 }, { flag: 'url_stripped', count: 1 }],
      assessments: { model: 7, deterministic: 3 },
      tokens_this_month: 1234,
    })
  })

  it('returns null rates with nothing shown', async () => {
    answer(undefined)
    const body = await (await GET()).json()
    expect(body.replies).toMatchObject({ total: 0, acceptance_rate: null, median_edit_distance: null })
    expect(body.guard_flags).toEqual([])
  })

  it('a database failure is a 500, never a crash', async () => {
    h.queryRaw.mockRejectedValue(new Error('db'))
    expect((await GET()).status).toBe(500)
  })
})
