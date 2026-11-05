// The shared runner every Phase 13 assistant feature uses for its one model
// call. It never throws to the route or job: every failure is a fallback
// reason the UI explains (AiFallback.<reason>).
//
// Order of operations:
//   1. deployment kill switch, then the member's permission, the workspace
//      switch and an active config with a key (isAiFeatureAvailable), then
//      the decrypted config (loadAiConfig);
//   2. redact personal data from every untrusted block, flag injection markers;
//   3. truncate to the feature budget, delimit as data with a fresh nonce;
//   4. usage limits held BEFORE the call (reserveAi, one source event per task);
//   5. generateReply with the feature's output cap and timeout (the sentinel
//      stripping and reasoning-leak withholding of parseGeneration apply);
//   6. strict JSON + zod validation when a schema is given;
//   7. output guards: medical and status claims, uncovered scripts, URL allowlist;
//   8. usage settled once and logged (settleAi), one content-free log line.
// The model gets no tools; context is fetched before the call by fixed
// read-only providers; output is plain text or validated JSON, never acted on.

import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { AccountRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { AuthError } from '@/lib/auth/errors';
import { databaseAdmin } from './admin-client';
import { failAi, reserveAi, settleAi, type AiReservation } from './budget';
import { loadAiConfig } from './config';
import { featureBudget, maxTokensFor } from './feature-budgets';
import { aiDeploymentEnabled } from './gate';
import { generateReply } from './generate';
import { logAiEvent } from './log';
import { checkOutputClaims, failClosedForScript } from './safety/claims';
import { redactForProvider } from './safety/redact';
import { delimitUntrusted, detectInjectionMarkers, stripUnlistedUrls } from './safety/untrusted';
import { isAiFeatureAvailable } from './settings';
import { usageLog } from './usage';
import {
  AiError, type AiAssistFeature, type AiConfig, type AiFallbackReason, type AiUsage,
  type KnowledgeCitation, type UntrustedBlock,
} from './types';

/** Fixed platform rules added to every assistant prompt (defence in depth; the code guards are authoritative). */
export const PLATFORM_RULES = [
  'You assist the staff of a business that talks to its customers on WhatsApp. Your output is reviewed by a human before anything reaches a customer.',
  'Never diagnose, never recommend a medicine, dose or treatment, and never claim a product cures or treats a condition. For health questions, say a qualified member of staff should answer.',
  'Never state that a payment was received or confirmed, a refund processed, attendance marked, an appointment attended, or an order shipped or delivered. Those statuses come only from the business records; say they should be checked there.',
  'Use only the facts in the supplied data. Do not invent prices, policies, order numbers, dates or links.',
  'Output only what is asked for, with no reasoning, notes or commentary.',
].join('\n');

export interface RunAiTaskArgs<T> {
  accountId: string;
  /** The member the task runs for (null in a job that rechecked its requester). */
  userId: string | null;
  role: AccountRole;
  feature: AiAssistFeature;
  /** Stored with the output (e.g. 'summary.v1'). */
  promptVersion: string;
  /** Feature instructions; the platform rules and the data-block note are added. */
  system: string;
  untrusted: UntrustedBlock[];
  /** When set, the output must be a JSON object that this schema accepts. */
  schema?: ZodType<T>;
  /** 'customer' output may reach a customer after staff review; 'staff' output never does. */
  audience: 'staff' | 'customer';
  conversationId?: string | null;
  /** Knowledge that grounded the input; returned unchanged and its URLs are allowed in the output. */
  citations?: KnowledgeCitation[];
  /** Extra URLs the output may contain (storefront, booking page). */
  allowedUrls?: readonly string[];
  /** Origins the output may link to (the agent profile's website). */
  allowedOrigins?: readonly string[];
  /** Health-type workspace: customer output in an uncovered script is withheld. */
  healthWorkspace?: boolean;
  /** Prisma client for the availability and budget checks (default: worker). */
  db?: PrismaClient;
  /** The source event this call meters (a job passes its task id); default: a fresh `task:<uuid>`. */
  sourceKey?: string;
}

export type RunAiTaskResult<T> =
  | { ok: true; value: T | string; usage: AiUsage | null; guardFlags: string[]; citations: KnowledgeCitation[]; provider: string; model: string }
  | { ok: false; reason: AiFallbackReason; guardFlags: string[] };

const errorReason = (error: unknown): AiFallbackReason => {
  if (error instanceof AiError) {
    if (error.code === 'ai_disabled') return 'deployment_off';
    if (error.code === 'timeout') return 'timeout';
  }
  return 'provider_error';
};

/** Parses a JSON object from model text (tolerates a ```json fence). */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Fits the blocks into `budget` characters: customer transcripts keep their latest text, other blocks their start. */
export function truncateBlocks(blocks: readonly UntrustedBlock[], budget: number): UntrustedBlock[] {
  let left = Math.max(0, budget);
  const out: UntrustedBlock[] = [];
  for (const block of blocks) {
    if (left <= 0) break;
    const text = block.text.length <= left ? block.text
      : block.source === 'customer' ? block.text.slice(block.text.length - left) : block.text.slice(0, left);
    left -= text.length;
    out.push({ ...block, text });
  }
  return out;
}

type Guarded = { value: unknown; blocked: boolean };

/** Applies the claim and URL guards to every string in `value`. */
function guardValue(value: unknown, apply: (s: string) => { text: string; blocked: boolean }): Guarded {
  if (typeof value === 'string') {
    const r = apply(value);
    return { value: r.text, blocked: r.blocked };
  }
  if (Array.isArray(value)) {
    let blocked = false;
    const items = value.map((v) => { const g = guardValue(v, apply); blocked ||= g.blocked; return g.value; });
    return { value: items, blocked };
  }
  if (value && typeof value === 'object') {
    let blocked = false;
    const entries = Object.entries(value).map(([k, v]) => { const g = guardValue(v, apply); blocked ||= g.blocked; return [k, g.value]; });
    return { value: Object.fromEntries(entries), blocked };
  }
  return { value, blocked: false };
}

/** Runs one assistant model call end to end. Never throws. */
export async function runAiTask<T>(args: RunAiTaskArgs<T>): Promise<RunAiTaskResult<T>> {
  const flags = new Set<string>();
  const fail = (reason: AiFallbackReason): RunAiTaskResult<T> => {
    logAiEvent({ feature: args.feature, reason, accountId: args.accountId, flags: [...flags] });
    return { ok: false, reason, guardFlags: [...flags] };
  };
  const startedAt = Date.now();
  try {
    if (!aiDeploymentEnabled()) return fail('deployment_off');
    const prisma = args.db ?? getWorkerPrisma();
    const ctx = { accountId: args.accountId, ...(args.userId ? { userId: args.userId } : {}), role: args.role };
    const availability = await withTenant(ctx, (tx) => isAiFeatureAvailable(tx, ctx, args.feature), prisma);
    if (!availability.ok) return fail(availability.reason);

    const admin = databaseAdmin({ accountId: args.accountId, role: 'owner' });
    let config: AiConfig | null;
    try {
      config = await loadAiConfig(admin, args.accountId);
    } catch {
      return fail('not_configured');
    }
    if (!config) return fail('not_configured');

    const budget = featureBudget(args.feature);
    const redacted = args.untrusted.map((block) => {
      const r = redactForProvider(block.text);
      if (r.redacted) flags.add('pii_redacted');
      if (detectInjectionMarkers(block.text).length) flags.add('injection_marker');
      return { ...block, text: r.text };
    });
    const blocks = truncateBlocks(redacted, budget.maxInputChars);
    if (blocks.reduce((n, b) => n + b.text.length, 0) < redacted.reduce((n, b) => n + b.text.length, 0)) flags.add('input_truncated');
    const delimited = delimitUntrusted(blocks);
    const systemPrompt = [PLATFORM_RULES, args.system, delimited.instruction,
      args.schema ? 'Reply with one JSON object only, no other text.' : ''].filter(Boolean).join('\n\n');
    const promptChars = systemPrompt.length + delimited.text.length;

    let reservation: AiReservation;
    try {
      reservation = await reserveAi(args.accountId, args.sourceKey ?? `task:${randomUUID()}`, {
        message: args.feature === 'suggest', tokens: maxTokensFor(args.feature, systemPrompt + delimited.text),
        workspaceCap: true,
      }, prisma);
    } catch (error) {
      if (error instanceof AuthError && error.status === 402) return fail('quota');
      throw error;
    }

    let generated: Awaited<ReturnType<typeof generateReply>>;
    try {
      generated = await generateReply({
        config, systemPrompt, messages: [{ role: 'user', content: delimited.text }],
        maxOutputTokens: budget.maxOutputTokens, timeoutMs: budget.timeoutMs,
      });
    } catch (error) {
      const reason = errorReason(error);
      // A timeout or server error after the request left may still be billed
      // on the key: settle the prompt (characters / 4). A refusal before the
      // request (deployment off) or a 4xx/auth error releases the hold.
      await failAi(reservation, error, promptChars);
      logAiEvent({ feature: args.feature, reason, accountId: args.accountId, provider: config.provider, model: config.model, error });
      return { ok: false, reason, guardFlags: [...flags] };
    }

    // The provider call happened: settle it whatever the guards decide.
    const log = usageLog({
      conversationId: args.conversationId ?? null, mode: args.feature,
      provider: config.provider, model: config.model, usage: generated.usage,
      estimate: { promptChars, outputChars: generated.text.length },
    });
    await settleAi(reservation, { tokens: log.totalTokens, log });

    if (!generated.text.trim()) return fail('invalid_output');
    let value: unknown = generated.text.trim();
    if (args.schema) {
      const parsed = args.schema.safeParse(parseJsonObject(generated.text));
      if (!parsed.success) return fail('invalid_output');
      value = parsed.data;
    }

    const urls = [...(args.citations ?? []).map((c) => c.source_url), ...(args.allowedUrls ?? [])];
    const guarded = guardValue(value, (text) => {
      const claims = checkOutputClaims(text);
      let out = text;
      let blocked = false;
      if (claims.blocked) {
        for (const c of claims.categories) flags.add(`claim_${c}`);
        if (args.audience === 'customer') blocked = true;
        else { out = claims.sanitized; flags.add('claim_replaced'); }
      }
      if (args.audience === 'customer' && failClosedForScript(out, args.healthWorkspace ?? false)) {
        flags.add('uncovered_script');
        blocked = true;
      }
      const stripped = stripUnlistedUrls(out, { urls, origins: args.allowedOrigins });
      if (stripped.stripped) flags.add('url_stripped');
      return { text: stripped.text, blocked };
    });
    if (guarded.blocked) return fail('guard_blocked');

    logAiEvent({
      feature: args.feature, reason: 'ok', accountId: args.accountId, provider: config.provider, model: config.model,
      latencyMs: Date.now() - startedAt, tokens: generated.usage?.totalTokens ?? null, flags: [...flags],
    });
    return {
      ok: true, value: guarded.value as T | string, usage: generated.usage, guardFlags: [...flags],
      citations: args.citations ?? [], provider: config.provider, model: config.model,
    };
  } catch (error) {
    // A database failure (availability, budget): no provider call was made.
    logAiEvent({ feature: args.feature, reason: 'task_failed', accountId: args.accountId, error });
    return { ok: false, reason: 'provider_error', guardFlags: [...flags] };
  }
}
