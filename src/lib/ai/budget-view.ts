// The monthly token budget card (AI page, Assistant features): tokens used
// this billing month (IST, the usage_counters 'ai_tokens' metric every AI
// call settles into), the workspace's own cap, the plan limit, whether the
// cap pauses the AI, when the month resets, and where the tokens went by
// feature (ai_usage_log, admins only by RLS). Read-only; inside withTenant.

import type { TenantTransaction } from '@/lib/db/tenant'
import { getEntitlements } from '@/lib/billing/entitlements'
import { aiTokensUsed } from '@/lib/billing/limits'
import { BILLING_TIME_ZONE } from '@/lib/billing/usage'
import { AI_USAGE_MODES, type AiUsageMode } from './types'
import { readAiSettings } from './settings'

export type BudgetState = 'ok' | 'warn' | 'over' | 'none'

export interface BudgetView {
  used: number
  /** The workspace's own cap (null: none). */
  cap: number | null
  /** The plan's monthly AI tokens (null: unlimited). */
  plan_limit: number | null
  /** The limit the bar is drawn against: the lower of the two, or null when both are unlimited. */
  limit: number | null
  pause_at_cap: boolean
  /** Start of the next billing month (ISO). */
  resets_at: string
  /** Tokens by feature this month; 'other' is metered usage with no log row (playground tests). */
  by_mode: { mode: AiUsageMode | 'other'; tokens: number }[]
  state: BudgetState
}

/** On track below 80 %, running low from 80 %, used up at 100 % of the limit. */
export function budgetState(used: number, limit: number | null): BudgetState {
  if (limit === null || limit <= 0) return 'none'
  const share = used / limit
  return share >= 1 ? 'over' : share >= 0.8 ? 'warn' : 'ok'
}

export async function readBudgetView(tx: TenantTransaction, accountId: string): Promise<BudgetView> {
  const settings = await readAiSettings(tx, accountId)
  const used = await aiTokensUsed(tx, accountId)
  const planLimit = (await getEntitlements(tx, accountId)).limits.ai_tokens_monthly
  const cap = settings.monthly_token_cap
  const limit = planLimit === null ? cap : cap === null ? planLimit : Math.min(planLimit, cap)
  const [period] = await tx.$queryRaw<{ resets_at: Date }[]>`
    SELECT ((date_trunc('month', now() AT TIME ZONE ${BILLING_TIME_ZONE}) + interval '1 month') AT TIME ZONE ${BILLING_TIME_ZONE}) AS resets_at`
  const rows = await tx.$queryRaw<{ mode: string; tokens: number }[]>`
    SELECT mode, COALESCE(sum(total_tokens), 0)::float8 AS tokens FROM ai_usage_log
    WHERE account_id=${accountId}::uuid
      AND created_at >= date_trunc('month', now() AT TIME ZONE ${BILLING_TIME_ZONE}) AT TIME ZONE ${BILLING_TIME_ZONE}
    GROUP BY mode`
  const byMode: BudgetView['by_mode'] = rows
    .filter((r) => (AI_USAGE_MODES as readonly string[]).includes(r.mode) && Number(r.tokens) > 0)
    .map((r) => ({ mode: r.mode as AiUsageMode, tokens: Math.round(Number(r.tokens)) }))
  const logged = byMode.reduce((n, r) => n + r.tokens, 0)
  if (used > logged) byMode.push({ mode: 'other', tokens: used - logged })
  byMode.sort((a, b) => b.tokens - a.tokens)
  return {
    used, cap, plan_limit: planLimit, limit, pause_at_cap: settings.pause_at_cap,
    resets_at: period.resets_at.toISOString(), by_mode: byMode, state: budgetState(used, limit),
  }
}
