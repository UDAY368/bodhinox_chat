import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: vi.fn().mockResolvedValue(true) }))
import { generateOpenAiCompatible } from './openai-compatible'

afterEach(() => vi.unstubAllGlobals())
const args = { apiKey: 'test-openrouter-key', model: 'openrouter/free', baseUrl: 'https://openrouter.ai/api/v1', systemPrompt: 'Business context', messages: [{ role: 'user' as const, content: 'Hello' }], timeoutMs: 1000 }
describe('OpenRouter through the existing agent adapter', () => {
  it('uses the free router with the existing conversation and token bound', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'Hello from the agent' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await generateOpenAiCompatible(args)).toMatchObject({ text: 'Hello from the agent', usage: { totalTokens: 15 } })
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'openrouter/free', max_tokens: 1024, messages: [{ role: 'system', content: 'Business context' }, { role: 'user', content: 'Hello' }] })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({ effort: 'low', exclude: true })
  })
  it.each([[401, 'invalid_key'], [402, 'quota_exceeded'], [403, 'access_denied'], [404, 'unsupported_model'], [429, 'rate_limited'], [503, 'provider_unavailable']])('maps HTTP %s into an actionable error without exposing the key', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: `Rejected test-openrouter-key` } }, { status: Number(status) })))
    const error = await generateOpenAiCompatible(args).catch(error => error)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain(args.apiKey)
    expect(error.message).toContain('OpenRouter')
  })
  it('redacts errors for the canonical official endpoint regardless of host case or default port', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { message: args.apiKey } }, { status: 401 })))
    const error = await generateOpenAiCompatible({ ...args, baseUrl: 'https://OPENROUTER.AI:443/api/v1' }).catch(error => error)
    expect(error.message).toContain('OpenRouter')
    expect(error.message).not.toContain(args.apiKey)
  })
})
