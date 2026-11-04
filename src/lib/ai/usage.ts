import type { DataClient } from '@/lib/data/types'
import { getWorkerPrisma } from '@/lib/db/prisma'
import { withTenant } from '@/lib/db/tenant'
import { incrementUsage } from '@/lib/billing/usage'
import type { AiProvider, AiUsage, AiUsageMode } from './types'
import { logAiEvent } from './log'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
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

/**
 * Adds `tokens` to the workspace's 'ai_tokens' counter for this IST month
 * (usage_counters, atomic billing_increment_usage), on the worker client
 * inside the workspace's tenant scope. Never throws.
 */
export async function countAiTokens(accountId: string, tokens: number): Promise<void> {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) return
  try {
    await withTenant({ accountId }, (tx) => incrementUsage(tx, 'ai_tokens', tokens), getWorkerPrisma())
  } catch (error) {
    logAiEvent({ feature: 'usage', reason: 'token_count_failed', accountId, error })
  }
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key — then counts the call's tokens
 * against the monthly 'ai_tokens' meter (plan limit ai_tokens_monthly and
 * the workspace cap). NEVER throws: usage accounting must not fail a reply
 * the customer is waiting on, so any DB error is logged as a reason code
 * (never the error object, which can carry row values) and swallowed.
 *
 * Pass the worker-backed admin client from the webhook or a route.
 */
export async function logAiUsage(
  db: DataClient,
  args: LogAiUsageArgs,
): Promise<void> {
  const usage = args.usage ?? estimateUsage(args.estimate)
  try {
    const { error } = await db.from('ai_usage_log').insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    })
    if (error) logAiEvent({ feature: 'usage', reason: 'log_insert_failed', accountId: args.accountId })
  } catch (error) {
    logAiEvent({ feature: 'usage', reason: 'log_insert_threw', accountId: args.accountId, error })
  }
  await countAiTokens(args.accountId, usage.totalTokens)
}
