import { AiError, type AiUsage, type ChatMessage } from '../types'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  /** Custom OpenAI-compatible base URL; omitted for native providers. */
  baseUrl?: string | null
  /** Output token cap; defaults to MAX_OUTPUT_TOKENS (short chat replies). */
  maxOutputTokens?: number
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

// ------------------------------------------------------------ retries

/** Waits before the 1st and 2nd retry (each ±25% jitter). Two retries at most. */
export const RETRY_DELAYS_MS = [400, 1200] as const
/** A Retry-After longer than this is not waited for: the call fails now. */
const MAX_RETRY_AFTER_MS = 2_000
/** A retry needs at least this much of the timeout budget left after its wait. */
const MIN_ATTEMPT_MS = 1_500

/** Test hook: how retries wait and jitter (real timers and Math.random by default). */
export const retryClock = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
}

/** A busy or failing provider: 429 or any 5xx. Other 4xx answers never change on a retry. */
export const retryableStatus = (status: number) => status === 429 || status >= 500

/** Retry-After in milliseconds (seconds or an HTTP date); null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const value = header.trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

const isTimeout = (err: unknown) => err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')

/**
 * fetch with up to two retries on 429, 5xx and network errors (never other
 * 4xx), all inside one `timeoutMs` budget so a reply is not held up: each
 * attempt gets what is left, and a retry runs only when its wait (jittered,
 * or a short Retry-After) still leaves MIN_ATTEMPT_MS. A timeout uses up the
 * budget and is not retried. Returns the last response, or throws the last
 * network error (map it with toNetworkError). Logs nothing.
 */
export async function fetchWithRetry(url: string, init: Omit<RequestInit, 'signal'>, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    const base = RETRY_DELAYS_MS[attempt]
    const jittered = base === undefined ? 0 : Math.round(base * (0.75 + 0.5 * retryClock.random()))
    const canWait = (wait: number) => base !== undefined && deadline - Date.now() - wait >= MIN_ATTEMPT_MS
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    } catch (err) {
      if (isTimeout(err) || !canWait(jittered)) throw err
      await retryClock.sleep(jittered)
      continue
    }
    if (!retryableStatus(res.status)) return res
    const after = retryAfterMs(res.headers.get('retry-after'))
    if (after !== null && after > MAX_RETRY_AFTER_MS) return res
    const wait = Math.max(after ?? 0, jittered)
    if (!canWait(wait)) return res
    if (!res.bodyUsed) await res.body?.cancel().catch(() => {})
    await retryClock.sleep(wait)
  }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError(t('ai.timeout'), {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(t('ai.unreachable', { message: msg }), {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? t('ai.invalidKey', { provider })
      : code === 'rate_limited'
        ? t('ai.rateLimited', { provider })
        : t('ai.apiError', { provider, status: String(status) })

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

/**
 * Collapse consecutive same-role turns into one (joined with blank
 * lines). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
