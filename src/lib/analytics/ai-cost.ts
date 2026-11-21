// Estimated AI cost: tokens from ai_usage_log (rolled into analytics_daily_ai_usage
// for past days) multiplied by the list price of each model. Always shown as an
// estimate: the provider's invoice is the record (discounts, caching, partner
// pricing and BYO-key plans are not seen here).
//
// Prices are list prices in US dollars per million tokens. A model missing from
// the table is not guessed: its tokens are reported as unpriced so the screen
// can say the estimate leaves them out. Update this table when prices change.

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { localDay, type AnalyticsRange } from './range';

export const AI_PRICES_AS_OF = '2026-11-03';

/** USD per million input / output tokens, by model id (provider-independent ids). */
export const AI_MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export interface AiUsageTotals { provider: string; model: string; promptTokens: number; completionTokens: number }

export interface AiCostEstimate {
  /** Estimated US dollars for the priced models, rounded to cents. */
  estimatedUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** Tokens of models with no list price in AI_MODEL_PRICES (left out of estimatedUsd). */
  unpricedTokens: number;
  byModel: { provider: string; model: string; promptTokens: number; completionTokens: number; estimatedUsd: number | null }[];
  pricesAsOf: string;
}

const priceOf = (model: string) => AI_MODEL_PRICES[model.trim().toLowerCase()] ?? null;

/** Pure: usage rows x the price table. */
export function estimateAiCost(rows: readonly AiUsageTotals[]): AiCostEstimate {
  let usd = 0, prompt = 0, completion = 0, unpriced = 0;
  const byModel = rows.map((r) => {
    const price = priceOf(r.model);
    prompt += r.promptTokens;
    completion += r.completionTokens;
    if (!price) {
      unpriced += r.promptTokens + r.completionTokens;
      return { ...r, estimatedUsd: null };
    }
    const cost = (r.promptTokens * price.input + r.completionTokens * price.output) / 1_000_000;
    usd += cost;
    return { ...r, estimatedUsd: Math.round(cost * 100) / 100 };
  });
  return { estimatedUsd: Math.round(usd * 100) / 100, promptTokens: prompt, completionTokens: completion,
    unpricedTokens: unpriced, byModel, pricesAsOf: AI_PRICES_AS_OF };
}

/**
 * Tokens per provider and model for the range: rolled days from
 * analytics_daily_ai_usage, and today (or any day not rolled yet) live from
 * ai_usage_log. Both tables are admin-only under RLS; the caller checks the
 * admin role. Bounded by the range (at most 366 days) and grouped in SQL.
 */
export async function aiUsageTotals(tx: TenantTransaction, accountId: string, range: AnalyticsRange,
  now: Date = new Date()): Promise<AiUsageTotals[]> {
  const today = localDay(now, range.timezone);
  const rows = await tx.$queryRaw<{ provider: string; model: string; p: number; c: number }[]>(Prisma.sql`
    WITH rolled AS (
      SELECT day, provider, model, prompt_tokens AS p, completion_tokens AS c FROM analytics_daily_ai_usage
      WHERE account_id=${accountId}::uuid AND day >= ${range.startDay}::date AND day <= ${range.endDay}::date
        AND day < ${today}::date
    ), rolled_days AS (
      SELECT day FROM analytics_daily WHERE account_id=${accountId}::uuid
        AND day >= ${range.startDay}::date AND day <= ${range.endDay}::date AND day < ${today}::date
    ), live AS (
      SELECT provider, model, prompt_tokens AS p, completion_tokens AS c FROM ai_usage_log
      WHERE account_id=${accountId}::uuid AND created_at >= ${range.from} AND created_at < ${range.to}
        AND (created_at AT TIME ZONE ${range.timezone})::date NOT IN (SELECT day FROM rolled_days)
    )
    SELECT provider, model, sum(p)::float8 AS p, sum(c)::float8 AS c FROM (
      SELECT provider, model, p, c FROM rolled UNION ALL SELECT provider, model, p, c FROM live
    ) u GROUP BY provider, model ORDER BY provider, model LIMIT 200`);
  return rows.map((r) => ({ provider: r.provider, model: r.model, promptTokens: Number(r.p), completionTokens: Number(r.c) }));
}
