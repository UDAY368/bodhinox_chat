import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

// A fake worker transaction routing the handful of statements the job runs.
const h = vi.hoisted(() => ({
  claim: null as null | Record<string, string>,
  role: 'agent' as string | null,
  allowed: true,
  settings: { insights_enabled: true },
  available: { ok: true } as { ok: true } | { ok: false; reason: string },
  computed: null as unknown,
  computeError: null as Error | null,
  done: null as null | unknown[],
  finished: [] as { status: unknown; code: unknown }[],
  calls: [] as { systemPrompt: string; content: string }[],
  reply: 'Agent 1 handled 40 of the 60 conversations.',
  logAiUsage: vi.fn(),
}))

const sqlOf = (q: unknown) => (Array.isArray(q) ? (q as string[]).join('?') : String(q))
const tx = {
  async $queryRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    const sql = sqlOf(strings)
    if (sql.includes("UPDATE ai_insight_runs SET status='running'")) return h.claim ? [h.claim] : []
    if (sql.includes('FROM account_memberships')) return h.role ? [{ role: h.role }] : []
    if (sql.includes('statement_timeout')) return []
    throw new Error(`unexpected query: ${sql} ${v.length}`)
  },
  async $executeRaw(strings: TemplateStringsArray, ...v: unknown[]) {
    const sql = sqlOf(strings)
    if (sql.includes("SET status='done'")) { h.done = v; return 1 }
    if (sql.includes('SET status=?')) { h.finished.push({ status: v[0], code: v[1] }); return 1 }
    throw new Error(`unexpected statement: ${sql}`)
  },
}

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, fn: (t: unknown) => unknown) => fn(tx) }))
vi.mock('@/lib/auth/permissions', () => ({ can: async () => h.allowed }))
vi.mock('@/lib/ai/settings', () => ({
  readAiSettings: async () => h.settings,
  isAiFeatureAvailable: async () => h.available,
}))
vi.mock('@/lib/analytics/range', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/range')>()),
  workspaceTimezone: async () => 'Asia/Kolkata',
}))
vi.mock('./registry', async (original) => ({
  ...(await original<typeof import('./registry')>()),
  accountCreatedDay: async () => '2026-01-01',
  computeInsight: async () => { if (h.computeError) throw h.computeError; return h.computed },
}))
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: async () => ({ provider: 'openai', model: 'gpt-test', baseUrl: null, apiKey: 'k', systemPrompt: null, isActive: true }),
}))
vi.mock('@/lib/ai/budget', () => ({ requireAiBudget: async () => undefined }))
vi.mock('@/lib/ai/usage', () => ({ countAiTokens: async () => {}, promptCharsOf: () => 0, logAiUsage: h.logAiUsage }))
vi.mock('@/lib/ai/admin-client', () => ({ databaseAdmin: () => ({}) }))
vi.mock('@/lib/billing/limits', () => ({ recordAiMessage: async () => undefined }))

import { setAiTransportForTests } from '@/lib/ai/providers/fake'
import { handleInsightRunJob } from './job'
import { agentWorkloadMetrics } from './registry'

const board = [
  { userId: 'u1', name: 'Asha Rao', role: 'agent', conversationsHandled: 40, repliesSent: 120, firstResponseCount: 30, medianFirstResponseSeconds: 300, resolved: 25 },
  { userId: 'u2', name: 'Ben Diaz', role: 'agent', conversationsHandled: 20, repliesSent: 50, firstResponseCount: 15, medianFirstResponseSeconds: 600, resolved: 10 },
]

const doneData = () => JSON.parse(h.done![0] as string)
const doneNarrative = () => h.done![4] as string
const doneSource = () => h.done![5] as string
const doneFlags = () => h.done![6] as string[]
const doneError = () => h.done![8] as string | null

beforeEach(() => {
  vi.stubEnv('AI_ENABLED', 'true')
  h.claim = { insight_key: 'agent_workload', range_from: '2026-10-01', range_to: '2026-10-31', requested_by: USER }
  h.role = 'agent'
  h.allowed = true
  h.settings = { insights_enabled: true }
  h.available = { ok: true }
  h.computed = agentWorkloadMetrics(board)
  h.computeError = null
  h.done = null
  h.finished = []
  h.calls = []
  h.reply = 'Agent 1 handled 40 of the 60 conversations.'
  h.logAiUsage.mockReset()
  setAiTransportForTests({
    async chat(args) {
      h.calls.push({ systemPrompt: args.systemPrompt, content: args.messages.map((m) => m.content).join('\n') })
      return { text: h.reply, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }
    },
    async embed() { return [] },
  })
})

afterEach(() => {
  setAiTransportForTests(null)
  vi.unstubAllEnvs()
})

describe('ai.insight_run job', () => {
  it('stores the numbers and a grounded model narrative with agent names restored for staff', async () => {
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.calls).toHaveLength(1)
    // The model saw numbers and labels only: no agent names.
    expect(h.calls[0].content).toContain('Agent 1')
    expect(h.calls[0].content).not.toContain('Asha')
    expect(h.calls[0].content).not.toContain('Ben')
    expect(doneSource()).toBe('model')
    expect(doneNarrative()).toBe('Asha Rao handled 40 of the 60 conversations.')
    expect(doneError()).toBeNull()
    const data = doneData()
    expect(data.metrics.conversations_handled).toBe(60)
    expect(data.dataFrom).toBe('2026-10-01')
    expect(data.dataTo).toBe('2026-10-31')
    // Agent attribution cutoff (2026-11-03) is after this range starts.
    expect(h.done![2]).toEqual(expect.arrayContaining(['agent_attribution_cutoff', 'csat_not_collected']))
    expect(h.done![3]).toBe('medium')
    expect(JSON.parse(h.done![7] as string)).toEqual([{ key: 'agent_workload', href: '/analytics' }])
  })

  it('falls back to the template narrative when the model quotes a number not in the data', async () => {
    h.reply = 'Agent 1 handled 75 conversations.'
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(doneSource()).toBe('template')
    expect(doneFlags()).toContain('ungrounded_number')
    expect(doneError()).toBe('ungrounded_number')
    expect(doneNarrative()).toContain('60 conversations')
  })

  it('makes no provider call with the deployment switch off and still completes from the numbers', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.calls).toHaveLength(0)
    expect(h.logAiUsage).not.toHaveBeenCalled()
    expect(doneSource()).toBe('template')
    expect(doneError()).toBe('deployment_off')
  })

  it.each(['not_configured', 'feature_off', 'quota'])('makes no provider call when the workspace is %s', async (reason) => {
    h.available = { ok: false, reason }
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.calls).toHaveLength(0)
    expect(doneSource()).toBe('template')
    expect(doneError()).toBe(reason)
  })

  it('skips a requester who is no longer a member, or was demoted below agent', async () => {
    for (const role of [null, 'viewer']) {
      h.role = role
      h.finished = []
      await handleInsightRunJob(ACCOUNT, { runId: RUN })
      expect(h.finished).toEqual([{ status: 'skipped', code: 'no_permission' }])
    }
    expect(h.calls).toHaveLength(0)
    expect(h.done).toBeNull()
  })

  it('skips when the role is restricted from ai.insights or the switch was turned off', async () => {
    h.allowed = false
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.finished).toEqual([{ status: 'skipped', code: 'no_permission' }])
    h.allowed = true
    h.settings = { insights_enabled: false }
    h.finished = []
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.finished).toEqual([{ status: 'skipped', code: 'feature_off' }])
    expect(h.calls).toHaveLength(0)
  })

  it('skips commerce for an agent-only insight below its minimum role', async () => {
    h.claim = { ...h.claim!, insight_key: 'commerce_sales' }
    h.role = 'viewer'
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    expect(h.finished).toEqual([{ status: 'skipped', code: 'no_permission' }])
  })

  it('does nothing for a run that is already finished or gone, or a malformed payload', async () => {
    h.claim = null
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    await handleInsightRunJob(ACCOUNT, { runId: 'not-a-uuid' })
    expect(h.done).toBeNull()
    expect(h.finished).toEqual([])
  })

  it('rethrows a database error for a retry and marks the run failed only on the last attempt', async () => {
    h.computeError = new Error('db down')
    await expect(handleInsightRunJob(ACCOUNT, { runId: RUN }, { attempts: 1, maxAttempts: 2 })).rejects.toThrow('db down')
    expect(h.finished).toEqual([])
    await expect(handleInsightRunJob(ACCOUNT, { runId: RUN }, { attempts: 2, maxAttempts: 2 })).rejects.toThrow('db down')
    expect(h.finished).toEqual([{ status: 'failed', code: 'job_failed' }])
    expect(h.calls).toHaveLength(0)
  })

  it('marks the run failed when the claim itself fails on the last attempt (no orphaned queued row)', async () => {
    const claimError = new Error('connection reset')
    const original = tx.$queryRaw
    tx.$queryRaw = async (strings: TemplateStringsArray, ...v: unknown[]) => {
      if (sqlOf(strings).includes("SET status='running'")) throw claimError
      return original(strings, ...v)
    }
    try {
      await expect(handleInsightRunJob(ACCOUNT, { runId: RUN }, { attempts: 2, maxAttempts: 2 })).rejects.toThrow('connection reset')
      expect(h.finished).toEqual([{ status: 'failed', code: 'job_failed' }])
    } finally {
      tx.$queryRaw = original
    }
  })

  it('never logs the narrative, the numbers or names', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await handleInsightRunJob(ACCOUNT, { runId: RUN })
    const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls])
    expect(logged).not.toContain('Asha')
    expect(logged).not.toContain('handled 40')
    expect(logged).not.toContain(ACCOUNT)
    info.mockRestore()
    error.mockRestore()
  })
})
