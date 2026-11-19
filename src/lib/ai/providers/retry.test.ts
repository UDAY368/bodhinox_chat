import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateOpenAi } from './openai'
import { fetchWithRetry, retryAfterMs, retryClock } from './shared'

const ok = () => Response.json({ choices: [{ message: { content: 'Hello' } }], usage: { total_tokens: 7 } })
const status = (code: number, headers: Record<string, string> = {}) => Response.json({ error: { message: 'busy' } }, { status: code, headers })
const args = { apiKey: 'sk-test', model: 'gpt-test', systemPrompt: 'Be brief.', messages: [{ role: 'user' as const, content: 'hi' }], timeoutMs: 20_000 }

describe('provider retries', () => {
  const waits: number[] = []
  beforeEach(() => {
    waits.length = 0
    vi.spyOn(retryClock, 'sleep').mockImplementation(async (ms) => { waits.push(ms) })
    vi.spyOn(retryClock, 'random').mockReturnValue(0.5)
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('retries a 429 and succeeds on the next answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(args)).resolves.toMatchObject({ text: 'Hello' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([400])
  })

  it('retries a 5xx and a network error', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(503)).mockRejectedValueOnce(new TypeError('reset')).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(args)).resolves.toMatchObject({ text: 'Hello' })
    expect(waits).toEqual([400, 1200])
  })

  it('never retries a 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(400))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(args)).rejects.toMatchObject({ code: 'provider_error' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('gives up after two retries', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => status(500))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(args)).rejects.toMatchObject({ code: 'provider_error' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([400, 1200])
  })

  it('does not retry a timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('slow', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(generateOpenAi(args)).rejects.toMatchObject({ code: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('waits for a short Retry-After and skips a long one', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(status(429, { 'retry-after': '1' })).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    await fetchWithRetry('https://example.test', {}, 20_000)
    expect(waits).toEqual([1000])

    const long = vi.fn().mockResolvedValue(status(429, { 'retry-after': '30' }))
    vi.stubGlobal('fetch', long)
    expect((await fetchWithRetry('https://example.test', {}, 20_000)).status).toBe(429)
    expect(long).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the wait would not fit the timeout budget', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => status(502))
    vi.stubGlobal('fetch', fetchMock)
    expect((await fetchWithRetry('https://example.test', {}, 1_000)).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs(new Date(10_000).toUTCString(), 9_000)).toBe(1000)
    expect(retryAfterMs('soon')).toBeNull()
    expect(retryAfterMs(null)).toBeNull()
  })
})
