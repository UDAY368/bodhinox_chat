import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { daysAgoStart, lastNDayKeys } from '@/lib/dashboard/date-utils'
import { getT } from '@/lib/i18n/translate'
import { AI_USAGE_MODES, type AiUsageMode } from '@/lib/ai/types'
import { logAiEvent } from '@/lib/ai/log'
import { aiUsageGroups, serverTimeZone, type UsageGroup } from '@/lib/ai/usage-summary'

const t = getT('Api')

const DEFAULT_WINDOW_DAYS = 30

/**
 * GET /api/ai/usage?days=30  (admin+)
 *
 * Token-spend summary for the account's BYO key over the last `days`
 * (1–90, default 30): totals, per-mode + per-model breakdowns, and a
 * zero-filled daily series for charting. Admin-only, mirroring the
 * `ai_usage_log` SELECT policy — spend is billing-class.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const url = new URL(request.url)
    const rawDays = Number(url.searchParams.get('days'))
    // Guard `>= 1`, not just `isFinite`: a missing/blank param is
    // Number(null)/Number('') === 0, which is finite — without the lower
    // bound the default would never apply and the window would collapse
    // to a single day.
    const days =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(90, Math.floor(rawDays))
        : DEFAULT_WINDOW_DAYS

    // Align the query cutoff to the START of the oldest local day we'll
    // chart (not a rolling `now - N*24h` instant). Otherwise rows in the
    // oldest partial day would be counted in the totals but fall outside
    // every daily bucket, so the chart's bars wouldn't sum to the
    // headline total. Local-day boundaries match every other dashboard
    // chart (see lib/dashboard/date-utils).
    const since = daysAgoStart(days - 1)

    // Aggregated in SQL by local day, mode, provider and model, so every AI
    // call in the window is counted however busy the workspace is.
    let groups: UsageGroup[]
    try {
      groups = await withTenant(tenantOf(ctx), (tx) => aiUsageGroups(tx, ctx.accountId, since, serverTimeZone()))
    } catch {
      logAiEvent({ feature: 'usage', reason: 'load_failed', accountId: ctx.accountId })
      return NextResponse.json(
        { error: t('ai.loadUsageFailed') },
        { status: 500 },
      )
    }

    // Totals.
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0

    // Per-mode + per-model tallies.
    // Every mode the DB allows (ai_usage_log_mode_check), so a new mode never throws.
    const byMode = Object.fromEntries(AI_USAGE_MODES.map((m) => [m, { calls: 0, tokens: 0 }])) as
      Record<AiUsageMode, { calls: number; tokens: number }>
    const modelMap = new Map<
      string,
      { model: string; provider: string; calls: number; tokens: number }
    >()

    // Zero-filled daily buckets so the chart shows quiet days as gaps,
    // not missing points. Local-day keys, oldest → newest — the same
    // helper every other dashboard chart uses, so day boundaries agree.
    const daily = new Map<string, { date: string; tokens: number; calls: number }>()
    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0 })
    }

    let calls = 0
    for (const r of groups) {
      calls += r.calls
      promptTokens += r.prompt_tokens
      completionTokens += r.completion_tokens
      totalTokens += r.total_tokens

      // `mode` is DB-CHECK-constrained; an unknown value is skipped, never thrown on.
      const bucketForMode = byMode[r.mode as AiUsageMode]
      if (bucketForMode) {
        bucketForMode.calls += r.calls
        bucketForMode.tokens += r.total_tokens
      }

      const mk = `${r.provider}:${r.model}`
      const m =
        modelMap.get(mk) ??
        { model: r.model, provider: r.provider, calls: 0, tokens: 0 }
      m.calls += r.calls
      m.tokens += r.total_tokens
      modelMap.set(mk, m)

      const bucket = daily.get(r.day)
      if (bucket) {
        bucket.tokens += r.total_tokens
        bucket.calls += r.calls
      }
    }

    const byModel = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens)

    return NextResponse.json({
      window_days: days,
      totals: {
        calls,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      by_mode: byMode,
      by_model: byModel,
      daily: [...daily.values()],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
