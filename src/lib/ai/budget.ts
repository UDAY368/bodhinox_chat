// AI metering: plan and workspace limits held BEFORE a provider call and
// settled once per source event after it (usage_events ledger,
// src/lib/billing/usage-ledger.ts).
//
//   const r = await reserveAi(accountId, sourceKey, { message, tokens })   // PlanLimitError (402) when over
//   ... provider call ...
//   await settleAi(r, { tokens: usage.totalTokens, log })                  // counts once, writes ai_usage_log
//   or on a failed call: await failAi(r, error, promptChars)               // timeout/5xx: prompt estimate; else released
//
// One source event meters once: an inbound message (`inbound:<message id>`), a
// flow AI turn, an assistant task (`task:<id>`) or a route request (`req:<uuid>`,
// reused by in-route retries). A replay after a crash may call the provider
// again but never meters twice; a crash between the call and settle leaves an
// expiring reservation and under-meters (absorbed by the platform).
//
// Fast path: when the plan's ai_messages and ai_tokens_monthly (and, for the
// assistant features, the workspace's monthly_token_cap) are all unlimited
// (every workspace without a subscription), nothing is reserved and settle
// records the usage once. The workspace cap applies only to the assistant
// features (summaries, suggested replies, assessments, insights: `workspaceCap`
// from runAiTask), as the AI settings say; auto-replies, flow AI replies, Draft,
// the playground and the generators are limited by the plan only.
// A plan-limit refusal records the 100% usage notice (notifyLimitRefused).
// Everything runs on the worker client inside the workspace's tenant scope.
// settleAi, releaseAi and failAi never throw: the reply must not fail on accounting.

import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getEntitlements, limitMessage, PlanLimitError, requireWithinLimit } from '@/lib/billing/entitlements';
import { aiTokensUsed, requireAiMessageRoom } from '@/lib/billing/limits';
import { ledgerKey, newRequestKey, recordUsage, releaseUsage, reserveUsage, settleUsage, type LedgerMetric } from '@/lib/billing/usage-ledger';
import { notifyLimitRefused, recordUsageNotices } from '@/lib/billing/usage-notices';
import type { LimitKey } from '@/lib/billing/entitlements-catalogue';
import { usagePeriod } from '@/lib/billing/usage';
import { MAX_OUTPUT_TOKENS } from './defaults';
import { promptTokenBound } from './feature-budgets';
import { logAiEvent } from './log';
import { AiError, type AiAssistFeature, type AiProvider, type AiUsage, type AiUsageMode } from './types';
import { usageLog } from './usage';

/** The workspace's own cap was reached (402, like a plan limit). */
export class AiWorkspaceCapError extends PlanLimitError {
  constructor() {
    super("This workspace's monthly AI token cap is reached. An admin can raise it in AI settings.");
  }
}

export interface AiReservation {
  accountId: string;
  sourceKey: string;
  /** This call counts one AI message (customer-facing text). */
  message: boolean;
  /** Which metrics hold a reservation (limit finite); the others are recorded on settle. */
  held: Record<LedgerMetric, boolean>;
  /** Finite plan limits for the usage notices (the workspace cap sends none). */
  planLimits: { ai_messages: number | null; ai_tokens_monthly: number | null };
  planName: string;
  db: PrismaClient;
}

async function workspaceTokenCap(tx: TenantTransaction, accountId: string): Promise<number | null> {
  const [row] = await tx.$queryRaw<{ cap: bigint | null }[]>`SELECT monthly_token_cap AS cap FROM ai_workspace_settings WHERE account_id=${accountId}::uuid`;
  return row?.cap === null || row?.cap === undefined ? null : Number(row.cap);
}

/** A worst-case token estimate for a chat call: the prompt bound plus the output cap. */
export function chatTokenEstimate(systemPrompt: string, messages: readonly { content: string }[], maxOutputTokens = MAX_OUTPUT_TOKENS): number {
  return promptTokenBound(systemPrompt) + messages.reduce((n, m) => n + promptTokenBound(m.content), 0) + maxOutputTokens;
}

/** A plan-limit refusal that names the limit key for its 100% usage notice. */
class AiPlanLimitError extends PlanLimitError {
  constructor(message: string, readonly limitKey: LimitKey) { super(message); }
}

/**
 * Holds room for one provider call. Throws PlanLimitError when the plan's
 * monthly AI messages (when `message`) or AI tokens would be exceeded (and
 * records the 100% usage notice), or, with `workspaceCap` (assistant features
 * only), AiWorkspaceCapError when the workspace's own token cap would be. Live
 * reservations of other calls count, so concurrent calls cannot overshoot.
 */
export async function reserveAi(accountId: string, sourceKey: string, input: { message: boolean; tokens: number; workspaceCap?: boolean },
  db: PrismaClient = getWorkerPrisma()): Promise<AiReservation> {
  const tokens = Math.max(1, Math.ceil(Number.isFinite(input.tokens) ? input.tokens : 1));
  sourceKey = ledgerKey(sourceKey);
  try {
    return await withTenant({ accountId, role: 'owner' }, async (tx) => {
      const e = await getEntitlements(tx, accountId);
      const cap = input.workspaceCap ? await workspaceTokenCap(tx, accountId) : null;
      const planTokens = e.limits.ai_tokens_monthly;
      const messages = input.message ? e.limits.ai_messages : null;
      const tokenLimit = planTokens === null ? cap : cap === null ? planTokens : Math.min(planTokens, cap);
      const held: Record<LedgerMetric, boolean> = { ai_messages: false, ai_tokens: false };
      if (messages !== null) {
        if (await reserveUsage(tx, 'ai_messages', sourceKey, 1, messages) === 'over_limit') {
          throw new AiPlanLimitError(limitMessage(e.planName, 'ai_messages', messages), 'ai_messages');
        }
        held.ai_messages = true;
      }
      if (tokenLimit !== null) {
        if (await reserveUsage(tx, 'ai_tokens', sourceKey, tokens, tokenLimit) === 'over_limit') {
          // Throwing rolls back the message reservation above too.
          throw cap !== null && (planTokens === null || cap <= planTokens)
            ? new AiWorkspaceCapError()
            : new AiPlanLimitError(limitMessage(e.planName, 'ai_tokens_monthly', planTokens as number), 'ai_tokens_monthly');
        }
        held.ai_tokens = true;
      }
      return {
        accountId, sourceKey, message: input.message, held, planName: e.planName, db,
        planLimits: { ai_messages: input.message ? e.limits.ai_messages : null, ai_tokens_monthly: planTokens },
      };
    }, db);
  } catch (error) {
    // Outside the rolled-back reserve transaction; the workspace's own cap sends no notice.
    if (error instanceof AiPlanLimitError) await notifyLimitRefused(accountId, error.limitKey);
    throw error;
  }
}

export interface AiUsageLog {
  conversationId: string | null;
  mode: AiUsageMode;
  provider: AiProvider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const nonNegative = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/**
 * Settles a call: one AI message when `message` (default: what was reserved;
 * false releases it), `tokens` actual tokens, then the ai_usage_log row in its
 * own short transaction. A settled source event is a no-op. Never throws.
 */
export async function settleAi(r: AiReservation, input: { tokens: number; message?: boolean; log?: AiUsageLog | AiUsageLog[] }): Promise<void> {
  const message = r.message && (input.message ?? true);
  const tokens = nonNegative(input.tokens);
  try {
    await withTenant({ accountId: r.accountId, role: 'owner' }, async (tx) => {
      const settle = async (metric: LedgerMetric, quantity: number) => {
        if (r.held[metric]) await settleUsage(tx, metric, r.sourceKey, quantity);
        else if (quantity > 0) await recordUsage(tx, metric, r.sourceKey, quantity);
      };
      if (message) await settle('ai_messages', 1);
      else if (r.held.ai_messages) await releaseUsage(tx, 'ai_messages', r.sourceKey);
      await settle('ai_tokens', tokens);
      await usageNotices(tx, r);
    }, r.db);
  } catch (error) {
    logAiEvent({ feature: 'usage', reason: 'usage_settle_failed', accountId: r.accountId, error });
  }
  for (const log of input.log === undefined ? [] : Array.isArray(input.log) ? input.log : [input.log]) await writeUsageLog(r, log);
}

/** The 80% / 100% notices for the finite plan limits this call counted against. */
async function usageNotices(tx: TenantTransaction, r: AiReservation): Promise<void> {
  const { ai_messages: messages, ai_tokens_monthly: tokens } = r.planLimits;
  if (messages === null && tokens === null) return;
  const period = usagePeriod();
  const rows = await tx.$queryRaw<{ metric: string; value: bigint }[]>`SELECT metric, value FROM usage_counters
    WHERE account_id=${r.accountId}::uuid AND period=${period} AND metric IN ('ai_messages','ai_tokens')`;
  const used = (metric: string) => Number(rows.find((row) => row.metric === metric)?.value ?? 0);
  if (messages !== null) await recordUsageNotices(tx, r.accountId, { key: 'ai_messages', used: used('ai_messages'), limit: messages, planName: r.planName });
  if (tokens !== null) await recordUsageNotices(tx, r.accountId, { key: 'ai_tokens_monthly', used: used('ai_tokens'), limit: tokens, planName: r.planName });
}

async function writeUsageLog(r: AiReservation, log: AiUsageLog): Promise<void> {
  try {
    await withTenant({ accountId: r.accountId, role: 'owner' }, (tx) => tx.$executeRaw`
      INSERT INTO ai_usage_log(account_id, conversation_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
      VALUES (${r.accountId}::uuid,
        (SELECT c.id FROM conversations c WHERE c.account_id=${r.accountId}::uuid AND c.id=${log.conversationId}::uuid),
        ${log.mode}, ${log.provider}, ${log.model.slice(0, 200)},
        ${nonNegative(log.promptTokens)}, ${nonNegative(log.completionTokens)}, ${nonNegative(log.totalTokens)})`, r.db);
  } catch (error) {
    logAiEvent({ feature: 'usage', reason: 'log_insert_failed', accountId: r.accountId, error });
  }
}

/** Gives back what was held: the provider definitely did not bill. Never throws. */
export async function releaseAi(r: AiReservation): Promise<void> {
  if (!r.held.ai_messages && !r.held.ai_tokens) return;
  try {
    await withTenant({ accountId: r.accountId, role: 'owner' }, async (tx) => {
      if (r.held.ai_messages) await releaseUsage(tx, 'ai_messages', r.sourceKey);
      if (r.held.ai_tokens) await releaseUsage(tx, 'ai_tokens', r.sourceKey);
    }, r.db);
  } catch (error) {
    logAiEvent({ feature: 'usage', reason: 'usage_release_failed', accountId: r.accountId, error });
  }
}

/** Whether a failed provider call may still be billed on the key (timeout or 5xx after the request left). */
export function billedOnFailure(error: unknown): boolean {
  if (!(error instanceof AiError)) return false;
  return error.code === 'timeout' || (error.code !== 'ai_disabled' && error.status >= 500);
}

/**
 * After a failed provider call: a timeout or server error settles the prompt
 * estimate (characters / 4) and no AI message; anything else releases. Never throws.
 */
export async function failAi(r: AiReservation, error: unknown, promptChars: number): Promise<void> {
  if (billedOnFailure(error)) await settleAi(r, { tokens: Math.ceil(Math.max(0, promptChars) / 4), message: false });
  else await releaseAi(r);
}

/**
 * Token hold for a JSON-generating route: two attempts at the JSON output cap
 * (JSON_GENERATION_MAX_OUTPUT_TOKENS, 8192, in flow-generator.ts) plus the prompt.
 * Settled to the actual usage.
 */
export const ROUTE_GENERATION_TOKENS = 2 * (8_192 + 4_000);

/**
 * One route request whose generator may call the provider more than once
 * (a corrective retry): the first attempt reserves under one `req:<uuid>` key,
 * every attempt's usage is collected, and `finish` settles them once (one AI
 * message, the sum of the tokens, one log row per call). Call `finish` after
 * the generator returns, and with the error when it throws.
 */
export function requestMeter(accountId: string, estimateTokens: number,
  log: { conversationId: string | null; mode: AiUsageMode; provider: AiProvider; model: string }) {
  const sourceKey = newRequestKey();
  let reservation: AiReservation | null = null;
  const logs: AiUsageLog[] = [];
  return {
    hooks: {
      beforeAttempt: async () => { reservation ??= await reserveAi(accountId, sourceKey, { message: true, tokens: estimateTokens }); },
      afterAttempt: (usage: AiUsage | null, estimate: { promptChars: number; outputChars: number }) => {
        logs.push(usageLog({ ...log, usage, estimate }));
      },
    },
    finish: async (error?: unknown): Promise<void> => {
      if (!reservation) return;
      if (logs.length) await settleAi(reservation, { tokens: logs.reduce((n, l) => n + l.totalTokens, 0), log: logs });
      else await failAi(reservation, error, 0);
    },
  };
}

/**
 * A read-only pre-check (no reservation) for work that spends tokens before
 * the metered call, such as knowledge retrieval: throws when `maxTokens` more
 * would exceed the plan's or the workspace's monthly tokens, and for 'suggest'
 * when the monthly AI messages are used up. reserveAi repeats it with a hold.
 */
export async function requireAiBudget(
  accountId: string,
  feature: AiAssistFeature,
  maxTokens: number,
  db: PrismaClient = getWorkerPrisma(),
): Promise<void> {
  const wanted = Math.max(1, Math.ceil(maxTokens));
  try {
    await withTenant({ accountId }, async (tx) => {
      const used = await aiTokensUsed(tx, accountId);
      await requireWithinLimit(tx, accountId, 'ai_tokens_monthly', used + wanted).catch((error) => {
        throw error instanceof PlanLimitError ? new AiPlanLimitError(error.message, 'ai_tokens_monthly') : error;
      });
      const cap = await workspaceTokenCap(tx, accountId);
      if (cap !== null && used + wanted > cap) throw new AiWorkspaceCapError();
    }, db);
    if (feature === 'suggest') {
      await requireAiMessageRoom(accountId, db).catch((error) => {
        throw error instanceof PlanLimitError ? new AiPlanLimitError(error.message, 'ai_messages') : error;
      });
    }
  } catch (error) {
    if (error instanceof AiPlanLimitError) await notifyLimitRefused(accountId, error.limitKey);
    throw error;
  }
}
