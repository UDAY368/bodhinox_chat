import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  readAiSettings: vi.fn(),
  isAiFeatureAvailable: vi.fn(),
  requireAiBudget: vi.fn(),
  loadAiConfig: vi.fn(),
  logAiUsage: vi.fn(),
  readConversation: vi.fn(),
  readCrmFacts: vi.fn(),
  replaceAssessment: vi.fn(),
  tenants: [] as unknown[],
}))
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }))
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => { h.tenants.push(ctx); return fn({}) },
}))
vi.mock('../settings', () => ({ readAiSettings: h.readAiSettings, isAiFeatureAvailable: h.isAiFeatureAvailable }))
vi.mock('../budget', () => ({ requireAiBudget: h.requireAiBudget }))
vi.mock('../config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('../usage', () => ({ countAiTokens: async () => {}, promptCharsOf: () => 0, logAiUsage: h.logAiUsage }))
vi.mock('../admin-client', () => ({ databaseAdmin: () => ({}) }))
vi.mock('@/lib/billing/limits', () => ({ recordAiMessage: vi.fn() }))
vi.mock('./repo', async (original) => ({
  ...(await original<typeof import('./repo')>()),
  readConversationForAssessment: h.readConversation,
  readCrmFacts: h.readCrmFacts,
  replaceAssessment: h.replaceAssessment,
}))

import { handleAssessConversationJob, mapEvidence, transcriptBlock } from './job'
import { setAiTransportForTests } from '../generate'
import { createFakeTransport, fakeCalls, resetFakeCalls } from '../providers/fake'
import type { NewAssessment } from './repo'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CONV = '33333333-3333-4333-8333-333333333333'
const CONTACT = '44444444-4444-4444-8444-444444444444'
const M1 = '55555555-5555-4555-8555-555555555551'
const M2 = '55555555-5555-4555-8555-555555555552'
const config = {
  provider: 'openai', model: 'gpt-x', baseUrl: null, apiKey: 'sk-test', systemPrompt: null, isActive: true,
  autoReplyEnabled: false, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
}
const conversation = (customerText: string) => ({
  contactId: CONTACT,
  messages: [
    { id: M1, sender: 'agent', text: 'Hi! How can we help?', createdAt: '2026-11-04T10:00:00.000Z' },
    { id: M2, sender: 'customer', text: customerText, createdAt: '2026-11-04T10:01:00.000Z' },
  ],
})
const run = (payload: Record<string, unknown> = { conversationId: CONV }) => handleAssessConversationJob(ACCOUNT, payload)
const stored = (): NewAssessment => h.replaceAssessment.mock.calls.at(-1)![1]

beforeEach(() => {
  delete process.env.AI_ENABLED
  resetFakeCalls()
  setAiTransportForTests(createFakeTransport())
  h.tenants.length = 0
  h.readAiSettings.mockReset().mockResolvedValue({ assessment_enabled: true })
  h.isAiFeatureAvailable.mockReset().mockResolvedValue({ ok: true })
  h.requireAiBudget.mockReset().mockResolvedValue(undefined)
  h.loadAiConfig.mockReset().mockResolvedValue(config)
  h.logAiUsage.mockReset().mockResolvedValue(undefined)
  h.readConversation.mockReset().mockResolvedValue(conversation('How much is the blue mug? I want to buy 2.'))
  h.readCrmFacts.mockReset().mockResolvedValue({ openDeal: true, customerMessages: 6, lastInboundAt: new Date() })
  h.replaceAssessment.mockReset().mockResolvedValue('row-id')
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  setAiTransportForTests(null)
  vi.restoreAllMocks()
})

describe('gates: no provider call, nothing customer-facing', () => {
  it('ignores a malformed payload', async () => {
    await run({ conversationId: 'not-a-uuid' })
    expect(h.readConversation).not.toHaveBeenCalled()
    expect(h.replaceAssessment).not.toHaveBeenCalled()
  })

  it('does nothing while the workspace has assessments off', async () => {
    h.readAiSettings.mockResolvedValue({ assessment_enabled: false })
    await run()
    expect(h.readConversation).not.toHaveBeenCalled()
    expect(h.replaceAssessment).not.toHaveBeenCalled()
    expect(fakeCalls()).toHaveLength(0)
  })

  it('keeps the keyword result with zero provider calls when the deployment switch is off', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    await run()
    expect(fakeCalls()).toHaveLength(0)
    expect(stored()).toMatchObject({ source: 'deterministic', leadScore: null, model: null, intent: 'purchase' })
    expect(stored().qualification.flags).toContain('fallback_deployment_off')
  })

  it.each(['not_configured', 'quota', 'no_permission'] as const)('keeps the keyword result when %s', async (reason) => {
    h.isAiFeatureAvailable.mockResolvedValue({ ok: false, reason })
    await run()
    expect(fakeCalls()).toHaveLength(0)
    expect(stored()).toMatchObject({ source: 'deterministic', leadScore: null })
  })

  it('never sends a health topic to the model and routes it to staff', async () => {
    h.readConversation.mockResolvedValue(conversation('I have chest pain and fever, what medicine should I take?'))
    await run()
    expect(fakeCalls()).toHaveLength(0)
    expect(h.isAiFeatureAvailable).not.toHaveBeenCalled()
    expect(stored()).toMatchObject({ intent: 'sensitive_health', source: 'deterministic', leadScore: null })
    expect(stored().qualification).toMatchObject({ route_to_staff: true, flags: ['sensitive_topic'] })
  })

  it('skips a conversation that is gone or has no customer text', async () => {
    h.readConversation.mockResolvedValueOnce(null)
    await run()
    h.readConversation.mockResolvedValueOnce({ contactId: CONTACT, messages: [{ id: M1, sender: 'agent', text: 'Hello', createdAt: '' }] })
    await run()
    expect(h.replaceAssessment).not.toHaveBeenCalled()
    expect(fakeCalls()).toHaveLength(0)
  })
})

describe('model path', () => {
  it('stores validated JSON with a lead score computed in code, on the worker', async () => {
    h.readConversation.mockResolvedValue(conversation(
      'Price for 2 blue mugs please, call me on +91 98765 43210 [[fake:json:intent=purchase,confidence=85,purchase_intent=true,asked_price=true,lead_score=100,rationale=Wants two mugs,evidence=m2]]'))
    await run()
    expect(fakeCalls()).toHaveLength(1)
    const call = fakeCalls()[0]
    // Delimited as data, redacted, and the score is not asked of the model.
    expect(call.messages[0].content).toMatch(/<untrusted-[0-9a-f]{16} source="customer" label="transcript">/)
    expect(call.messages[0].content).not.toContain('98765')
    expect(call.systemPrompt).toContain('Do not output a score')
    const row = stored()
    expect(row).toMatchObject({
      source: 'model', model: 'gpt-x', intent: 'purchase', intentConfidence: 85, rationale: 'Wants two mugs',
      sourceMessageIds: [M1, M2], promptVersion: 'assess.v1', contactId: CONTACT, conversationId: CONV,
    })
    // 10 base + 25 purchase + 15 price + 10 deal + 10 recent + 5 engagement; the model's lead_score is ignored.
    expect(row.leadScore).toBe(75)
    expect(row.qualification).toMatchObject({ evidence_message_ids: [M2], route_to_staff: false })
    expect(row.qualification.flags).toContain('pii_redacted')
    expect(h.tenants.every((t) => (t as { role?: string }).role === 'owner')).toBe(true)
    expect(h.logAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: 'assess', conversationId: CONV }))
  })

  it('drops and flags evidence that is not a transcript message', async () => {
    h.readConversation.mockResolvedValue(conversation('price? [[fake:json:intent=pricing,confidence=60,evidence=m9]]'))
    await run()
    expect(stored().qualification).toMatchObject({ evidence_message_ids: [] })
    expect(stored().qualification.flags).toContain('evidence_dropped')
  })

  it.each([
    ['invalid_json', 'fallback_invalid_output'],
    ['timeout', 'fallback_timeout'],
    ['error_429', 'fallback_provider_error'],
  ])('falls back to the keyword result on %s without throwing', async (scenario, flag) => {
    h.readConversation.mockResolvedValue(conversation(`how much does it cost? [[fake:${scenario}]]`))
    await expect(run()).resolves.toBeUndefined()
    expect(stored()).toMatchObject({ source: 'deterministic', intent: 'pricing', leadScore: null })
    expect(stored().qualification.flags).toContain(flag)
  })

  it('falls back on an intent outside the enum', async () => {
    h.readConversation.mockResolvedValue(conversation('how much? [[fake:json:intent=upsell,confidence=90]]'))
    await run()
    expect(stored()).toMatchObject({ source: 'deterministic', intent: 'pricing' })
  })
})

describe('durability', () => {
  it('retries once when a concurrent run won the current-row index', async () => {
    vi.stubEnv('AI_ENABLED', 'off')
    h.replaceAssessment.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }))
    await run()
    expect(h.replaceAssessment).toHaveBeenCalledTimes(2)
  })

  it('lets a database error fail the job so it is retried', async () => {
    h.readConversation.mockRejectedValue(new Error('connection lost'))
    await expect(run()).rejects.toThrow('connection lost')
  })
})

describe('helpers', () => {
  it('labels transcript lines and maps evidence back to ids', () => {
    const { text, refs } = transcriptBlock(conversation('hello\n  there').messages as never)
    expect(text).toBe('[m1] Staff: Hi! How can we help?\n[m2] Customer: hello there')
    expect(mapEvidence('m2, m7', refs)).toEqual({ ids: [M2], dropped: true })
    expect(mapEvidence(['m1', 'M2'], refs)).toEqual({ ids: [M1, M2], dropped: false })
    expect(mapEvidence(undefined, refs)).toEqual({ ids: [], dropped: false })
  })
})
