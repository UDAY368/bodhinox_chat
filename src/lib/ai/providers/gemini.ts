import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { mergeConsecutive, normalizeUsage, toNetworkError, type ProviderArgs } from './shared'

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

async function geminiHttpError(res: Response): Promise<AiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: {
      status?: string
      message?: string
      details?: { reason?: string }[]
    }
  } | null
  const status = body?.error?.status ?? ''
  const message = body?.error?.message ?? ''
  const reasons = body?.error?.details?.map((item) => item.reason) ?? []

  // Do not return the provider's raw error text: it may contain submitted
  // prompt content. These categories are enough for settings and logs.
  if (res.status === 401 || res.status === 403 || reasons.includes('API_KEY_INVALID')) {
    return new AiError('Gemini rejected GEMINI_API_KEY.', { code: 'invalid_key', status: 401 })
  }
  if (res.status === 404 || /model.*(not found|not supported)/i.test(message)) {
    return new AiError('This Gemini model is unavailable. Choose a supported model.', {
      code: 'unsupported_model', status: 400,
    })
  }
  if (res.status === 402 || status === 'FAILED_PRECONDITION' ||
      (res.status === 429 && /quota|credit|billing|limit: 0/i.test(message))) {
    return new AiError('Gemini quota or billing is unavailable for this key.', {
      code: 'quota_exceeded', status: 429,
    })
  }
  if (res.status === 429) {
    return new AiError('Gemini rate limit reached. Try again later.', {
      code: 'rate_limited', status: 429,
    })
  }
  return new AiError(`Gemini request failed (HTTP ${res.status}).`, {
    code: 'provider_error', status: 502,
  })
}

/** Native Gemini GenerateContent adapter for the shared draft/playground/auto-reply path. */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  if (!apiKey) {
    throw new AiError('GEMINI_API_KEY is not configured on the server.', {
      code: 'key_not_configured', status: 400,
    })
  }
  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new AiError('Enter a valid Gemini model ID.', {
      code: 'unsupported_model', status: 400,
    })
  }

  const turns = mergeConsecutive(messages)
  while (turns[0]?.role === 'assistant') turns.shift()
  if (turns.length === 0) {
    turns.push({ role: 'user', content: '(The customer has not sent a message yet.)' })
  }

  let res: Response
  try {
    res = await fetch(`${GEMINI_API}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: turns.map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }],
        })),
        generationConfig: { maxOutputTokens: args.maxOutputTokens ?? MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await geminiHttpError(res)
  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const candidate = data?.candidates?.[0]
  const text = candidate?.content?.parts
    ?.filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim()
  if (!text) {
    const blocked = !!data?.promptFeedback?.blockReason ||
      ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(candidate?.finishReason ?? '')
    throw new AiError(blocked ? 'Gemini blocked this prompt or response.' : 'Gemini returned no reply.', {
      code: blocked ? 'content_blocked' : 'empty_response',
    })
  }

  return {
    text,
    usage: normalizeUsage({
      prompt: data?.usageMetadata?.promptTokenCount,
      completion: data?.usageMetadata?.candidatesTokenCount,
      total: data?.usageMetadata?.totalTokenCount,
    }),
  }
}
