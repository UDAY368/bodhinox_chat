// Workspace switches for the AI business assistant (ai_workspace_settings)
// and the one availability check every assistant feature runs first.
//
// A missing row means every feature is off. Turning a feature on is not
// enough to call a provider: the deployment kill switch (AI_ENABLED) must
// not be off, the workspace needs an active AI config with a key, the
// member's role must allow the feature, and the monthly limits must have room.

import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { AccountRole } from '@/lib/auth/roles';
import { can, type FeaturePermission } from '@/lib/auth/permissions';
import { getEntitlements } from '@/lib/billing/entitlements';
import { aiTokensUsed } from '@/lib/billing/limits';
import { aiDeploymentEnabled } from './gate';
import { geminiApiKey } from './gemini-key';
import type { AiAssistFeature, AiFallbackReason } from './types';
import type { AiGoal } from '@/lib/flows/types';
import { autoReplyGoalsProblem, parseGoals } from './goal-rules';

export interface AiWorkspaceSettings {
  summaries_enabled: boolean;
  suggestions_enabled: boolean;
  assessment_enabled: boolean;
  insights_enabled: boolean;
  /** Optional cap on AI tokens per IST month; null = only the plan limit applies. */
  monthly_token_cap: number | null;
  /** Stage 5 (5G): up to 3 ordered goals for the Instagram AI auto-reply; [] is today's behaviour. */
  instagram_goals: AiGoal[];
  updated_at: string | null;
}

export type AiToggleKey = 'summaries_enabled' | 'suggestions_enabled' | 'assessment_enabled' | 'insights_enabled';
export const AI_TOGGLE_KEYS: readonly AiToggleKey[] = ['summaries_enabled', 'suggestions_enabled', 'assessment_enabled', 'insights_enabled'];

export const DEFAULT_AI_SETTINGS: AiWorkspaceSettings = {
  summaries_enabled: false,
  suggestions_enabled: false,
  assessment_enabled: false,
  insights_enabled: false,
  monthly_token_cap: null,
  instagram_goals: [],
  updated_at: null,
};

/** The switch each feature needs. */
export const FEATURE_TOGGLE: Record<AiAssistFeature, AiToggleKey> = {
  summary: 'summaries_enabled',
  suggest: 'suggestions_enabled',
  assess: 'assessment_enabled',
  insights: 'insights_enabled',
};

/** The permission each feature needs (role ceiling plus workspace restrictions). */
export const FEATURE_PERMISSION: Record<AiAssistFeature, FeaturePermission> = {
  summary: 'ai.assist',
  suggest: 'ai.assist',
  assess: 'ai.assess',
  insights: 'ai.insights',
};

/** Largest workspace token cap accepted (fits bigint and a JS safe integer). */
export const MAX_MONTHLY_TOKEN_CAP = 1_000_000_000_000;

interface SettingsRow {
  summaries_enabled: boolean;
  suggestions_enabled: boolean;
  assessment_enabled: boolean;
  insights_enabled: boolean;
  monthly_token_cap: bigint | null;
  instagram_goals: unknown;
  updated_at: Date | null;
}

const toSettings = (row: SettingsRow | undefined): AiWorkspaceSettings => row
  ? {
    summaries_enabled: row.summaries_enabled,
    suggestions_enabled: row.suggestions_enabled,
    assessment_enabled: row.assessment_enabled,
    insights_enabled: row.insights_enabled,
    monthly_token_cap: row.monthly_token_cap === null ? null : Number(row.monthly_token_cap),
    instagram_goals: parseGoals(row.instagram_goals),
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  }
  : { ...DEFAULT_AI_SETTINGS, instagram_goals: [] };

/** The workspace's switches (all off when there is no row). Inside the caller's tenant transaction. */
export async function readAiSettings(tx: TenantTransaction, accountId: string): Promise<AiWorkspaceSettings> {
  const rows = await tx.$queryRaw<SettingsRow[]>`SELECT summaries_enabled, suggestions_enabled, assessment_enabled, insights_enabled,
    monthly_token_cap, instagram_goals, updated_at FROM ai_workspace_settings WHERE account_id=${accountId}::uuid`;
  return toSettings(rows[0]);
}

export type AiSettingsPatch = Partial<Pick<AiWorkspaceSettings, AiToggleKey | 'monthly_token_cap' | 'instagram_goals'>>;

/**
 * Upserts the given switches as `ctx.userId` and audits 'ai.settings_updated'
 * (the changed keys and values only). RLS requires an admin. Inside the
 * caller's tenant transaction.
 */
export async function writeAiSettings(
  tx: TenantTransaction,
  ctx: { accountId: string; userId: string },
  patch: AiSettingsPatch,
): Promise<AiWorkspaceSettings> {
  const current = await readAiSettings(tx, ctx.accountId);
  const next = { ...current, ...patch };
  const cap = next.monthly_token_cap === null ? null : BigInt(next.monthly_token_cap);
  await tx.$executeRaw`INSERT INTO ai_workspace_settings(account_id, summaries_enabled, suggestions_enabled, assessment_enabled,
      insights_enabled, monthly_token_cap, instagram_goals, updated_by)
    VALUES(${ctx.accountId}::uuid, ${next.summaries_enabled}, ${next.suggestions_enabled}, ${next.assessment_enabled},
      ${next.insights_enabled}, ${cap}::bigint, ${JSON.stringify(next.instagram_goals)}::jsonb, ${ctx.userId}::uuid)
    ON CONFLICT (account_id) DO UPDATE SET summaries_enabled=EXCLUDED.summaries_enabled,
      suggestions_enabled=EXCLUDED.suggestions_enabled, assessment_enabled=EXCLUDED.assessment_enabled,
      insights_enabled=EXCLUDED.insights_enabled, monthly_token_cap=EXCLUDED.monthly_token_cap,
      instagram_goals=EXCLUDED.instagram_goals, updated_by=EXCLUDED.updated_by`;
  // Audited by key and value; goals by their types only (a link is the author's, but kept out of the log).
  const changed = Object.fromEntries(Object.entries(patch)
    .filter(([k, v]) => JSON.stringify(current[k as keyof AiWorkspaceSettings]) !== JSON.stringify(v))
    .map(([k, v]) => [k, k === 'instagram_goals' ? (v as AiGoal[]).map((g) => g.type) : v]));
  if (Object.keys(changed).length)
    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, 'ai.settings_updated', ${ctx.accountId}, ${JSON.stringify(changed)}::jsonb)`;
  return readAiSettings(tx, ctx.accountId);
}

/** The patch in `body`, or null when anything in it is invalid or nothing is set. */
export function parseSettingsPatch(body: unknown): AiSettingsPatch | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const patch: AiSettingsPatch = {};
  for (const key of AI_TOGGLE_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') return null;
    patch[key] = input[key] as boolean;
  }
  if ('monthly_token_cap' in input) {
    const cap = input.monthly_token_cap;
    if (cap === null) patch.monthly_token_cap = null;
    else if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 && cap <= MAX_MONTHLY_TOKEN_CAP) patch.monthly_token_cap = cap;
    else return null;
  }
  if ('instagram_goals' in input) {
    if (autoReplyGoalsProblem(input.instagram_goals) !== null) return null;
    // Only the known fields of each goal are kept.
    patch.instagram_goals = (input.instagram_goals as AiGoal[]).map((g): AiGoal => g.type === 'share_link'
      ? { type: 'share_link', url: g.url, ...(g.label ? { label: g.label } : {}) }
      : g.type === 'grow_followers' ? { type: 'grow_followers' } : { type: 'capture_lead', fields: [...g.fields], on_refusal: g.on_refusal });
  }
  return Object.keys(patch).length ? patch : null;
}

/** True when the workspace has an active AI config with a usable chat key (no decryption, no provider call). */
export async function aiConfigured(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ provider: string; has_key: boolean; is_active: boolean }[]>(Prisma.sql`
    SELECT provider, (api_key IS NOT NULL AND api_key <> '') AS has_key, is_active FROM ai_configs WHERE account_id=${accountId}::uuid`);
  const row = rows[0];
  if (!row || !row.is_active) return false;
  return row.provider === 'gemini' ? !!geminiApiKey() : row.has_key;
}

export type AiUnavailableReason = Extract<AiFallbackReason, 'deployment_off' | 'not_configured' | 'feature_off' | 'no_permission' | 'quota'>;
export type AiAvailability = { ok: true } | { ok: false; reason: AiUnavailableReason };

/**
 * May this member use this assistant feature now? Checks, in order: the
 * deployment kill switch, the member's permission, the workspace switch, an
 * active AI config with a key, and that this month's token limits are not
 * already used up. Makes no provider call. Inside the caller's tenant
 * transaction; jobs pass role 'owner' and recheck the requester themselves.
 */
export async function isAiFeatureAvailable(
  tx: TenantTransaction,
  ctx: { accountId: string; role?: AccountRole | null },
  feature: AiAssistFeature,
): Promise<AiAvailability> {
  if (!aiDeploymentEnabled()) return { ok: false, reason: 'deployment_off' };
  if (!ctx.role || !(await can(tx, { accountId: ctx.accountId, role: ctx.role }, FEATURE_PERMISSION[feature])))
    return { ok: false, reason: 'no_permission' };
  const settings = await readAiSettings(tx, ctx.accountId);
  if (!settings[FEATURE_TOGGLE[feature]]) return { ok: false, reason: 'feature_off' };
  if (!(await aiConfigured(tx, ctx.accountId))) return { ok: false, reason: 'not_configured' };
  const used = await aiTokensUsed(tx, ctx.accountId);
  const limit = (await getEntitlements(tx, ctx.accountId)).limits.ai_tokens_monthly;
  if ((limit !== null && used >= limit) || (settings.monthly_token_cap !== null && used >= settings.monthly_token_cap))
    return { ok: false, reason: 'quota' };
  return { ok: true };
}
