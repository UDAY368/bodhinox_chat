import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ readAiSettings: vi.fn(), enqueueJob: vi.fn(), withTenant: vi.fn() }))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/db/tenant', () => ({ withTenant: h.withTenant }))
vi.mock('../settings', () => ({ readAiSettings: h.readAiSettings }))
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: h.enqueueJob }))

import { enqueueAssessmentForInbound } from './enqueue'
import { AI_ASSESS_SLOT_MS, assessJobSlot } from './job'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CONV = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  delete process.env.AI_ENABLED
  h.withTenant.mockReset().mockImplementation(async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}))
  h.readAiSettings.mockReset().mockResolvedValue({ assessment_enabled: true })
  h.enqueueJob.mockReset().mockResolvedValue('job-id')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('enqueueAssessmentForInbound', () => {
  it('queues one debounced job per conversation slot on the worker, run at the slot end', async () => {
    const now = 7 * AI_ASSESS_SLOT_MS + 1234
    expect(await enqueueAssessmentForInbound(ACCOUNT, CONV, now)).toBe(true)
    expect(h.withTenant).toHaveBeenCalledWith({ accountId: ACCOUNT, role: 'owner' }, expect.any(Function), { worker: true })
    expect(h.enqueueJob).toHaveBeenCalledWith('ai.assess_conversation', { conversationId: CONV },
      { tenantId: ACCOUNT, dedupeKey: `ai-assess:${CONV}:7`, runAt: new Date(8 * AI_ASSESS_SLOT_MS), maxAttempts: 3 })
    // A burst inside the slot shares the dedupe key.
    expect(assessJobSlot(CONV, now + 1000).dedupeKey).toBe(`ai-assess:${CONV}:7`)
  })

  it('does nothing, without touching the database, when the deployment switch is off', async () => {
    vi.stubEnv('AI_ENABLED', 'FALSE')
    expect(await enqueueAssessmentForInbound(ACCOUNT, CONV)).toBe(false)
    expect(h.withTenant).not.toHaveBeenCalled()
    expect(h.enqueueJob).not.toHaveBeenCalled()
  })

  it('does nothing while the workspace has assessments off', async () => {
    h.readAiSettings.mockResolvedValue({ assessment_enabled: false })
    expect(await enqueueAssessmentForInbound(ACCOUNT, CONV)).toBe(false)
    expect(h.enqueueJob).not.toHaveBeenCalled()
  })

  it('never throws into the inbound job and logs only a reason code', async () => {
    h.enqueueJob.mockRejectedValue(new Error(`duplicate key value ${CONV} secret customer text`))
    expect(await enqueueAssessmentForInbound(ACCOUNT, CONV)).toBe(false)
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)
    expect(logged).toContain('enqueue_failed')
    expect(logged).not.toContain('customer text')
    expect(logged).not.toContain(ACCOUNT)
  })
})
