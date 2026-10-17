import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateGemini } from './gemini'

const args = {
  apiKey: 'test-key',
  model: 'gemini-3.8-flash',
  systemPrompt: 'Reply briefly.',
  messages: [
    { role: 'assistant' as const, content: 'Welcome' },
    { role: 'user' as const, content: 'Hello' },
    { role: 'assistant' as const, content: 'Hi' },
    { role: 'user' as const, content: 'What is the price?' },
  ],
  timeoutMs: 1000,
}

afterEach(() => vi.unstubAllGlobals())

describe('native Gemini adapter', () => {
  it('sends the agent prompt and turns to Google and normalizes text and usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Checking now.' }] } }],
      usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 4, totalTokenCount: 22 },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateGemini(args)).resolves.toEqual({
      text: 'Checking now.',
      usage: { promptTokens: 18, completionTokens: 4, totalTokens: 22 },
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent')
    expect(init.headers['x-goog-api-key']).toBe('test-key')
    expect(init.redirect).toBe('manual')
    expect(url + init.body).not.toContain('test-key')
    const body = JSON.parse(init.body)
    expect(body.systemInstruction.parts[0].text).toBe('Reply briefly.')
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
      { role: 'user', parts: [{ text: 'What is the price?' }] },
    ])
  })

  it.each([
    [400, 'API_KEY_INVALID', 'invalid_key'],
    [403, 'PERMISSION_DENIED', 'invalid_key'],
    [404, 'NOT_FOUND', 'unsupported_model'],
    [402, 'RESOURCE_EXHAUSTED', 'quota_exceeded'],
    [429, 'RESOURCE_EXHAUSTED', 'rate_limited'],
  ])('maps HTTP %i to %s or the relevant category', async (status, errorStatus, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        status: errorStatus,
        message: 'Provider failure',
        details: status === 400 ? [{ reason: 'API_KEY_INVALID' }] : [],
      },
    }), { status })))
    await expect(generateGemini(args)).rejects.toMatchObject({ code })
  })

  it('separates quota exhaustion from temporary rate limiting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for this project' },
    }), { status: 429 })))
    await expect(generateGemini(args)).rejects.toMatchObject({ code: 'quota_exceeded' })
  })

  it('handles blocked replies and network failures without exposing the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      promptFeedback: { blockReason: 'SAFETY' },
    }), { status: 200 })))
    await expect(generateGemini(args)).rejects.toMatchObject({ code: 'content_blocked' })

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(generateGemini(args)).rejects.toMatchObject({ code: 'network_error' })
  })

  it('rejects missing keys and malformed model IDs before a network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateGemini({ ...args, apiKey: '' })).rejects.toMatchObject({ code: 'key_not_configured' })
    await expect(generateGemini({ ...args, model: 'bad/model?key=x' })).rejects.toMatchObject({ code: 'unsupported_model' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
