// Retention for AI assistant data ('ai.retention_sweep'), daily per
// workspace that has something due (crm_accounts_with_ai_retention_due()).
//
// scheduleAiRetention runs on every worker tick (handlers.ts scheduleWork)
// and calls the due function once per IST day per process after a success
// (at most once an hour while it keeps failing). It queues one sweep per listed
// workspace, deduped per workspace per IST day. runAiRetentionSweep applies
// the fixed rules below on the worker role inside that workspace's tenant
// scope, in batches of AI_RETENTION.batchSize rows, each batch its own short
// transaction. A sweep stops after MAX_BATCHES_PER_RULE batches per rule; the
// rest stays due and is picked up the next day.
//
// Rules (design section 13):
//   ai_suggestions   output and citations cleared after 30 days (status and
//                    edit distance stay for the quality page); row deleted after 180
//   ai_assessments   superseded rows deleted after 30 days; every row after 180
//   ai_insight_runs  deleted after 90 days
//   ai_usage_log     deleted after 400 days
//   ai_reply_events  deleted after 90 days (the auto-reply activity log, which
//                    holds capped customer text and replies)
// Nothing else is touched: conversations.ai_handoff_summary, messages,
// knowledge and ai_unanswered_questions are out of scope (deferred).

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { logAiEvent } from './log';

export const AI_RETENTION_JOB = 'ai.retention_sweep';

export const AI_RETENTION = {
  /** ai_suggestions: output and citations cleared after this many days. */
  suggestionContentDays: 30,
  /** ai_suggestions: row deleted after this many days. */
  suggestionRowDays: 180,
  /** ai_assessments: superseded rows deleted after this many days. */
  supersededAssessmentDays: 30,
  /** ai_assessments: every row deleted after this many days. */
  assessmentDays: 180,
  /** ai_insight_runs: deleted after this many days. */
  insightRunDays: 90,
  /** ai_usage_log: deleted after this many days. */
  usageLogDays: 400,
  /** ai_reply_events: deleted after this many days. */
  replyEventDays: 90,
  batchSize: 1000,
} as const;

/** Batches per rule in one sweep (bounds the job; the rest is due again tomorrow). */
export const MAX_BATCHES_PER_RULE = 50;

const SCHEDULE_INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let lastSchedule = Number.NEGATIVE_INFINITY;
let lastScheduledDay: string | null = null;
let missingFunctionLogged = false;

/** The IST calendar day of `now`, as YYYY-MM-DD. */
export function istDay(now: number): string {
  return new Date(Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

export const aiRetentionDedupeKey = (accountId: string, now: number): string => `ai-retention:${accountId}:${istDay(now)}`;

/** Queues one sweep per workspace with retention due, once per IST day. Returns how many were queued. */
export async function scheduleAiRetention(now: number = Date.now(), force = false): Promise<number> {
  if (!force && (lastScheduledDay === istDay(now) || now - lastSchedule < SCHEDULE_INTERVAL_MS)) return 0;
  lastSchedule = now;
  let accounts: { account_id: string }[];
  try {
    accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text AS account_id FROM crm_accounts_with_ai_retention_due()`;
  } catch (error) {
    // Not migrated yet on this database: nothing to sweep, say so once.
    if (/crm_accounts_with_ai_retention_due|42883/.test(error instanceof Error ? error.message : '')) {
      if (!missingFunctionLogged) logAiEvent({ feature: 'retention', reason: 'function_missing' });
      missingFunctionLogged = true;
      return 0;
    }
    throw error;
  }
  let queued = 0;
  for (const { account_id } of accounts) {
    if (!UUID.test(account_id)) continue;
    queued += await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${AI_RETENTION_JOB},${account_id}::uuid,'{}'::jsonb,${aiRetentionDedupeKey(account_id, now)},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  lastScheduledDay = istDay(now);
  return queued;
}

/** Test hook. */
export function resetAiRetentionScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
  lastScheduledDay = null;
  missingFunctionLogged = false;
}

export interface AiRetentionResult {
  suggestionsDeleted: number;
  suggestionsCleared: number;
  assessmentsDeleted: number;
  insightRunsDeleted: number;
  usageLogDeleted: number;
  replyEventsDeleted: number;
}

type Rule = (tx: TenantTransaction, accountId: string, limit: number) => Promise<number>;

// Each statement touches at most `limit` rows of this workspace, oldest first.
const RULES: Record<keyof AiRetentionResult, Rule> = {
  // Deleting first means the clearing pass never rewrites rows about to go.
  suggestionsDeleted: (tx, a, limit) => tx.$executeRaw`DELETE FROM ai_suggestions WHERE id IN (
      SELECT id FROM ai_suggestions WHERE account_id=${a}::uuid
        AND created_at < now() - make_interval(days => ${AI_RETENTION.suggestionRowDays}::int)
      ORDER BY created_at LIMIT ${limit}::int)`,
  suggestionsCleared: (tx, a, limit) => tx.$executeRaw`UPDATE ai_suggestions SET output='{}'::jsonb, citations='[]'::jsonb WHERE id IN (
      SELECT id FROM ai_suggestions WHERE account_id=${a}::uuid
        AND created_at < now() - make_interval(days => ${AI_RETENTION.suggestionContentDays}::int)
        AND (output <> '{}'::jsonb OR citations <> '[]'::jsonb)
      ORDER BY created_at LIMIT ${limit}::int)`,
  assessmentsDeleted: (tx, a, limit) => tx.$executeRaw`DELETE FROM ai_assessments WHERE id IN (
      SELECT id FROM ai_assessments WHERE account_id=${a}::uuid
        AND (created_at < now() - make_interval(days => ${AI_RETENTION.assessmentDays}::int)
          OR superseded_at < now() - make_interval(days => ${AI_RETENTION.supersededAssessmentDays}::int))
      ORDER BY created_at LIMIT ${limit}::int)`,
  insightRunsDeleted: (tx, a, limit) => tx.$executeRaw`DELETE FROM ai_insight_runs WHERE id IN (
      SELECT id FROM ai_insight_runs WHERE account_id=${a}::uuid
        AND created_at < now() - make_interval(days => ${AI_RETENTION.insightRunDays}::int)
      ORDER BY created_at LIMIT ${limit}::int)`,
  usageLogDeleted: (tx, a, limit) => tx.$executeRaw`DELETE FROM ai_usage_log WHERE id IN (
      SELECT id FROM ai_usage_log WHERE account_id=${a}::uuid
        AND created_at < now() - make_interval(days => ${AI_RETENTION.usageLogDays}::int)
      ORDER BY created_at LIMIT ${limit}::int)`,
  replyEventsDeleted: (tx, a, limit) => tx.$executeRaw`DELETE FROM ai_reply_events WHERE id IN (
      SELECT id FROM ai_reply_events WHERE account_id=${a}::uuid
        AND created_at < now() - make_interval(days => ${AI_RETENTION.replyEventDays}::int)
      ORDER BY created_at LIMIT ${limit}::int)`,
};

/**
 * Applies the retention rules to one workspace on the worker role. Only
 * database errors throw (the job is then retried). Logs counts only.
 */
export async function runAiRetentionSweep(accountId: string): Promise<AiRetentionResult> {
  if (!UUID.test(accountId)) throw new Error('Invalid tenant identity');
  const worker = { accountId, role: 'owner' as const };
  const limit = AI_RETENTION.batchSize;
  const result: AiRetentionResult = {
    suggestionsDeleted: 0, suggestionsCleared: 0, assessmentsDeleted: 0, insightRunsDeleted: 0, usageLogDeleted: 0, replyEventsDeleted: 0,
  };
  for (const key of Object.keys(RULES) as (keyof AiRetentionResult)[]) {
    for (let batch = 0; batch < MAX_BATCHES_PER_RULE; batch++) {
      const n = await withTenant(worker, (tx) => RULES[key](tx, accountId, limit), getWorkerPrisma());
      result[key] += n;
      if (n < limit) break;
    }
  }
  logAiEvent({
    feature: 'retention', reason: 'done', accountId,
    flags: Object.entries(result).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`),
  });
  return result;
}
