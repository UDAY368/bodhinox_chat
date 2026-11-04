import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  contexts: [] as unknown[],
}))
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({ $queryRaw: h.queryRaw, $executeRaw: h.executeRaw }),
}))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => {
    h.contexts.push(ctx)
    return fn({ $executeRaw: h.executeRaw })
  },
}))

import {
  AI_RETENTION, AI_RETENTION_JOB, MAX_BATCHES_PER_RULE, aiRetentionDedupeKey, istDay,
  resetAiRetentionScheduleForTests, runAiRetentionSweep, scheduleAiRetention,
} from './retention'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?')

beforeEach(() => {
  resetAiRetentionScheduleForTests()
  h.queryRaw.mockReset()
  h.executeRaw.mockReset()
  h.contexts.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('istDay', () => {
  it('rolls over at IST midnight, not UTC midnight', () => {
    expect(istDay(Date.parse('2026-11-04T18:29:00Z'))).toBe('2026-11-04')
    expect(istDay(Date.parse('2026-11-04T18:31:00Z'))).toBe('2026-11-05')
    expect(aiRetentionDedupeKey(A, Date.parse('2026-11-04T10:00:00Z'))).toBe(`ai-retention:${A}:2026-11-04`)
  })
})

describe('scheduleAiRetention', () => {
  it('queues one deduped sweep per due workspace, calling the due function once per IST day', async () => {
    h.queryRaw.mockResolvedValue([{ account_id: A }, { account_id: B }])
    h.executeRaw.mockResolvedValue(1)
    const now = Date.parse('2026-11-04T10:00:00Z')
    expect(await scheduleAiRetention(now)).toBe(2)
    expect(sqlOf(h.queryRaw.mock.calls[0])).toContain('crm_accounts_with_ai_retention_due()')
    const insert = h.executeRaw.mock.calls[0]
    expect(sqlOf(insert)).toContain('ON CONFLICT(dedupe_key) DO NOTHING')
    expect(insert.slice(1)).toEqual([AI_RETENTION_JOB, A, `ai-retention:${A}:2026-11-04`])
    // The rest of the same IST day: no further scan of the due function.
    expect(await scheduleAiRetention(now + 30 * 60_000)).toBe(0)
    expect(await scheduleAiRetention(now + 5 * 60 * 60_000)).toBe(0)
    expect(h.queryRaw).toHaveBeenCalledTimes(1)
    // The next IST day (00:00 IST = 18:30 UTC): scanned again, with the new day's key.
    expect(await scheduleAiRetention(Date.parse('2026-11-04T18:31:00Z'))).toBe(2)
    expect(h.queryRaw).toHaveBeenCalledTimes(2)
    expect(h.executeRaw.mock.calls.at(-1)?.[3]).toBe(`ai-retention:${B}:2026-11-05`)
  })

  it('retries a failed due check after an hour, not on every tick', async () => {
    const now = Date.parse('2026-11-04T10:00:00Z')
    h.queryRaw.mockRejectedValueOnce(new Error('connection refused'))
    await expect(scheduleAiRetention(now)).rejects.toThrow('connection refused')
    expect(await scheduleAiRetention(now + 10 * 60_000)).toBe(0)
    expect(h.queryRaw).toHaveBeenCalledTimes(1)
    h.queryRaw.mockResolvedValue([])
    expect(await scheduleAiRetention(now + 61 * 60_000)).toBe(0)
    expect(h.queryRaw).toHaveBeenCalledTimes(2)
  })

  it('skips a malformed account id from the function', async () => {
    h.queryRaw.mockResolvedValue([{ account_id: 'nope' }])
    expect(await scheduleAiRetention(Date.now(), true)).toBe(0)
    expect(h.executeRaw).not.toHaveBeenCalled()
  })

  it('treats a missing function (not migrated) as nothing due, and rethrows other errors', async () => {
    h.queryRaw.mockRejectedValueOnce(Object.assign(new Error('function crm_accounts_with_ai_retention_due() does not exist'), { code: '42883' }))
    expect(await scheduleAiRetention(Date.now(), true)).toBe(0)
    h.queryRaw.mockRejectedValueOnce(new Error('connection refused'))
    await expect(scheduleAiRetention(Date.now(), true)).rejects.toThrow('connection refused')
  })
})

describe('runAiRetentionSweep', () => {
  it('applies every rule on the worker in this workspace only, deleting before clearing', async () => {
    h.executeRaw.mockResolvedValue(0)
    const out = await runAiRetentionSweep(A)
    expect(out).toEqual({ suggestionsDeleted: 0, suggestionsCleared: 0, assessmentsDeleted: 0, insightRunsDeleted: 0, usageLogDeleted: 0 })
    const sql = h.executeRaw.mock.calls.map(sqlOf)
    expect(sql).toHaveLength(5)
    expect(sql[0]).toMatch(/^DELETE FROM ai_suggestions/)
    expect(sql[1]).toMatch(/^UPDATE ai_suggestions SET output='\{\}'::jsonb, citations='\[\]'::jsonb/)
    expect(sql[2]).toMatch(/^DELETE FROM ai_assessments/)
    expect(sql[3]).toMatch(/^DELETE FROM ai_insight_runs/)
    expect(sql[4]).toMatch(/^DELETE FROM ai_usage_log/)
    for (const call of h.executeRaw.mock.calls) {
      expect(call[1]).toBe(A)
      expect(sqlOf(call)).toContain('account_id=?::uuid')
    }
    // Day counts and the batch size are the fixed constants.
    expect(h.executeRaw.mock.calls[0]).toContain(AI_RETENTION.suggestionRowDays)
    expect(h.executeRaw.mock.calls[1]).toContain(AI_RETENTION.suggestionContentDays)
    expect(h.executeRaw.mock.calls[2]).toEqual(expect.arrayContaining([AI_RETENTION.assessmentDays, AI_RETENTION.supersededAssessmentDays]))
    expect(h.executeRaw.mock.calls[3]).toContain(AI_RETENTION.insightRunDays)
    expect(h.executeRaw.mock.calls[4]).toContain(AI_RETENTION.usageLogDays)
    expect(h.executeRaw.mock.calls[4]).toContain(AI_RETENTION.batchSize)
    expect(h.contexts.every((c) => JSON.stringify(c) === JSON.stringify({ accountId: A, role: 'owner' }))).toBe(true)
  })

  it('repeats a rule while batches are full, and stops at the per-sweep cap', async () => {
    const full = AI_RETENTION.batchSize
    // usage log: always full -> capped; suggestions deleted: two full batches then a partial.
    h.executeRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.startsWith('DELETE FROM ai_usage_log')) return full
      if (sql.startsWith('DELETE FROM ai_suggestions')) {
        const n = h.executeRaw.mock.calls.filter((c) => sqlOf(c).startsWith('DELETE FROM ai_suggestions')).length
        return n <= 2 ? full : 7
      }
      return 0
    })
    const out = await runAiRetentionSweep(A)
    expect(out.suggestionsDeleted).toBe(2 * full + 7)
    expect(out.usageLogDeleted).toBe(MAX_BATCHES_PER_RULE * full)
  })

  it('logs counts only, with a hashed account id', async () => {
    h.executeRaw.mockResolvedValue(3)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await runAiRetentionSweep(A)
    const line = JSON.stringify(info.mock.calls)
    expect(line).not.toContain(A)
    expect(line).toContain('suggestionsDeleted:3')
  })

  it('rethrows database errors so the job retries, and refuses a malformed id', async () => {
    h.executeRaw.mockRejectedValue(new Error('deadlock'))
    await expect(runAiRetentionSweep(A)).rejects.toThrow('deadlock')
    await expect(runAiRetentionSweep('x')).rejects.toThrow('Invalid tenant identity')
  })
})
