// Token usage of one provider call, for metering (settleAi in ./budget) and
// the ai_usage_log row (cost visibility on the account's BYO key). Every path
// is metered: when the provider reports no usage, characters / 4 is used.

import type { AiProvider, AiUsage, AiUsageMode } from './types'
import type { AiUsageLog } from './budget'

export interface UsageLogArgs {
  /** Null for a draft not tied to one thread; a deleted thread is stored as null. */
  conversationId: string | null
  mode: AiUsageMode
  provider: AiProvider
  model: string
  /** Provider usage. When null, `estimate` is used instead. */
  usage: AiUsage | null
  /** Prompt and output lengths, for an estimate (characters / 4) when the
   *  provider reported no usage. Required so every path is metered. */
  estimate: { promptChars: number; outputChars: number }
}

/** Characters of a chat prompt (system prompt plus every message), for `estimate`. */
export function promptCharsOf(systemPrompt: string, messages: readonly { content: string }[]): number {
  return systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)
}

/** characters / 4, the usual rough token estimate. */
export function estimateUsage(estimate: { promptChars: number; outputChars: number }): AiUsage {
  const promptTokens = Math.max(0, Math.ceil(estimate.promptChars / 4))
  const completionTokens = Math.max(0, Math.ceil(estimate.outputChars / 4))
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

/** The ai_usage_log row for one call: the provider's usage, else the estimate. */
export function usageLog(args: UsageLogArgs): AiUsageLog {
  const usage = args.usage ?? estimateUsage(args.estimate)
  return {
    conversationId: args.conversationId, mode: args.mode, provider: args.provider, model: args.model,
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
  }
}
