// The AI usage page's numbers (GET /api/ai/usage), aggregated in SQL so a busy
// workspace is summarised in full: one row per local day, mode, provider and
// model (at most 90 days x a few modes x a few models), never one per AI call.
// Runs inside withTenant; ai_usage_log RLS limits it to admins of the workspace.

import type { TenantTransaction } from '@/lib/db/tenant'

export interface UsageGroup {
  /** Local calendar day, YYYY-MM-DD, in `timeZone`. */
  day: string
  mode: string
  provider: string
  model: string
  calls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/

/** The process's IANA time zone (the one the usage chart's day keys use), else UTC. */
export function serverTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone && TIME_ZONE.test(zone) ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Usage since `since`, grouped by local day (in `timeZone`), mode, provider and model. */
export async function aiUsageGroups(
  tx: TenantTransaction,
  accountId: string,
  since: Date,
  timeZone: string,
): Promise<UsageGroup[]> {
  const zone = TIME_ZONE.test(timeZone) ? timeZone : 'UTC'
  const rows = await tx.$queryRaw<UsageGroup[]>`
    SELECT to_char(created_at AT TIME ZONE ${zone}, 'YYYY-MM-DD') AS day, mode, provider, model,
      count(*)::int AS calls,
      COALESCE(sum(prompt_tokens), 0)::float8 AS prompt_tokens,
      COALESCE(sum(completion_tokens), 0)::float8 AS completion_tokens,
      COALESCE(sum(total_tokens), 0)::float8 AS total_tokens
    FROM ai_usage_log
    WHERE account_id = ${accountId}::uuid AND created_at >= ${since}
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4`
  return rows.map((r) => ({
    day: r.day, mode: r.mode, provider: r.provider, model: r.model,
    calls: Number(r.calls), prompt_tokens: Number(r.prompt_tokens),
    completion_tokens: Number(r.completion_tokens), total_tokens: Number(r.total_tokens),
  }))
}
