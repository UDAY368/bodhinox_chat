import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataClient } from '@/lib/data/types'
import { aiDeploymentEnabled, assertProviderCallAllowed } from './gate'
import { generateReply, setAiTransportForTests } from './generate'
import { embedTexts } from './embeddings'
import { loadAiConfig, loadEmbeddingsKey } from './config'
import { createFakeTransport, fakeCalls, resetFakeCalls } from './providers/fake'
import { withDryRun, DryRunSideEffectError } from '@/lib/runtime/dry-run-guard'
import { AiError, type AiConfig } from './types'

const config: AiConfig = {
  provider: 'openai', model: 'gpt-x', baseUrl: null, apiKey: 'sk-test', systemPrompt: null, isActive: true,
  autoReplyEnabled: false, autoReplyMaxPerConversation: 3, handoffAgentId: null, embeddingsApiKey: null,
}

beforeEach(() => {
  resetFakeCalls()
  setAiTransportForTests(createFakeTransport())
})
afterEach(() => {
  vi.unstubAllEnvs()
  setAiTransportForTests(null)
  vi.restoreAllMocks()
})

describe('aiDeploymentEnabled (emergency kill switch)', () => {
  it('is on when AI_ENABLED is unset, so existing live AI keeps working', () => {
    vi.stubEnv('AI_ENABLED', undefined as unknown as string)
    delete process.env.AI_ENABLED
    expect(aiDeploymentEnabled()).toBe(true)
  })

  it.each(['true', 'TRUE', '1', 'yes', ''])('is on for AI_ENABLED=%j', (value) => {
    vi.stubEnv('AI_ENABLED', value)
    expect(aiDeploymentEnabled()).toBe(true)
  })

  it.each(['false', 'FALSE', ' False ', '0', 'off', 'OFF'])('is off for AI_ENABLED=%j', (value) => {
    vi.stubEnv('AI_ENABLED', value)
    expect(aiDeploymentEnabled()).toBe(false)
    expect(() => assertProviderCallAllowed()).toThrow(AiError)
    try { assertProviderCallAllowed() } catch (e) { expect(e).toMatchObject({ code: 'ai_disabled', status: 503 }) }
  })
})

describe('every provider path passes the gate first', () => {
  it('generateReply makes zero transport calls when AI_ENABLED=false', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(generateReply({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toMatchObject({ code: 'ai_disabled' })
    expect(fakeCalls()).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('embedTexts makes zero transport calls when AI_ENABLED=false', async () => {
    vi.stubEnv('AI_ENABLED', 'off')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(embedTexts('sk-test', ['ping'])).rejects.toMatchObject({ code: 'ai_disabled' })
    expect(fakeCalls()).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a flow dry run can never reach a provider', async () => {
    await expect(withDryRun(() => generateReply({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }] })))
      .rejects.toBeInstanceOf(DryRunSideEffectError)
    await expect(withDryRun(() => embedTexts('sk-test', ['x']))).rejects.toBeInstanceOf(DryRunSideEffectError)
    expect(fakeCalls()).toHaveLength(0)
  })

  it('with the switch unset the call goes through unchanged (existing AI keeps working)', async () => {
    delete process.env.AI_ENABLED
    const out = await generateReply({ config, systemPrompt: 's', messages: [{ role: 'user', content: 'hi [[fake:handoff]]' }] })
    expect(out).toMatchObject({ handoff: true, text: '' })
    expect(await embedTexts('sk-test', ['a', 'b'])).toHaveLength(2)
    expect(fakeCalls().map((c) => c.kind)).toEqual(['chat', 'embed'])
  })

  it('passes the feature timeout and output cap to the transport', async () => {
    const chat = vi.fn(async () => ({ text: 'ok', usage: null }))
    setAiTransportForTests({ chat, embed: async () => [] })
    await generateReply({ config, systemPrompt: 's', messages: [], maxOutputTokens: 300, timeoutMs: 5_000 })
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 300, timeoutMs: 5_000 }))
  })
})

describe('config loading while the switch is off', () => {
  const db = () => {
    const from = vi.fn(() => { throw new Error('must not query') })
    return { db: { from } as unknown as DataClient, from }
  }

  it('loadAiConfig reports "not configured" without reading the database', async () => {
    vi.stubEnv('AI_ENABLED', 'false')
    const { db: client, from } = db()
    expect(await loadAiConfig(client, 'acct', { requireActive: false })).toBeNull()
    expect(from).not.toHaveBeenCalled()
  })

  it('loadEmbeddingsKey reports no key, so ingest stores lexical chunks only', async () => {
    vi.stubEnv('AI_ENABLED', '0')
    const { db: client, from } = db()
    expect(await loadEmbeddingsKey(client, 'acct')).toEqual({ key: null, corrupt: false })
    expect(from).not.toHaveBeenCalled()
  })
})

describe('the test transport', () => {
  it('cannot be installed outside Vitest', () => {
    vi.stubEnv('VITEST', 'false')
    expect(() => setAiTransportForTests(createFakeTransport())).toThrow()
  })
})
