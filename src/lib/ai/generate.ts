import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { NO_ANSWER_SENTINEL } from './confidence'
import { generateOpenAi } from './providers/openai'
import { generateOpenAiCompatible } from './providers/openai-compatible'
import { generateAnthropic } from './providers/anthropic'
import { generateGemini } from './providers/gemini'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Output token cap. Omit for chat replies (MAX_OUTPUT_TOKENS); JSON generators pass more. */
  maxOutputTokens?: number
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, maxOutputTokens } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    baseUrl: config.baseUrl,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'openai_compatible':
      result = await generateOpenAiCompatible(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    case 'gemini':
      result = await generateGemini(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  // Providers can put commentary in ordinary content even when separate
  // reasoning is excluded. Withhold the whole turn rather than guessing
  // which part is a safe customer answer.
  // Both control phrases are stripped here, so no caller can ever send
  // a raw [[HANDOFF]] or [[NO_ANSWER]] to a customer.
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const noAnswer = raw.includes(NO_ANSWER_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').split(NO_ANSWER_SENTINEL).join('').trim()
    .replace(/^(?:#{1,6}\s*)?[*_]{0,2}(?:response|reply|final (?:answer|response))[*_]{0,2}\s*:[*_]{0,2}\s*/i, '')
  const plain = text.replace(/[*_`]/g, '')
  const reasoningMarkup = /<\s*\/?\s*(?:think(?:ing)?|analysis|reasoning|scratchpad)\b|\[(?:analysis|reasoning)\]|<\|(?:analysis|channel|im_start|start_header_id)\|>/i
  const reasoningHeading = /(?:^|\n)[\t ]*(?:#{1,6}[\t ]*)?(?:reasoning|analysis|internal notes?|thought process|chain of thought|scratchpad)[\t ]*(?::|\r?$)/im
  const customerAnalysis = /(?:^|[\n.!?])\s*(?:#{1,6}\s*)?(?:(?:note|explanation)\s*:\s*)?the (?:user|customer) (?:appears|seems|is (?:asking|requesting|speaking|switching|writing))\b/i
  if (reasoningMarkup.test(raw) || reasoningHeading.test(plain) || customerAnalysis.test(plain)) {
    return { text: '', handoff: true, usage, ...(noAnswer ? { noAnswer } : {}) }
  }
  return { text, handoff, usage, ...(noAnswer ? { noAnswer } : {}) }
}
