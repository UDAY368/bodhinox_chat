// Platform console: plan configuration (Phase 14). Server only.
//
// A plan edit is published as a new immutable version (plan_versions) through
// crm_platform_publish_plan_version, which repeats every rule below in SQL.
// Subscribers stay pinned to the version they subscribed under; the live row
// (the newest version) applies to workspaces without a pin: no subscription
// (enterprise), a non-granting status (free) and unpinned granting rows.
//
// Rules (code and SQL):
//   - keys must be FEATURES / LIMITS; features are booleans, limits JSON null
//     (unlimited) or non-negative safe integers;
//   - 'enterprise' is the legacy fallback of every workspace without a
//     subscription: no finite limit, no feature turned off (403 plan_locked);
//   - a publish echoes the preview_hash of a preview of the same draft against
//     the same current version (409 preview_mismatch otherwise);
//   - "Move subscribers to latest version" is a separate, audited action that
//     names the version it moves to; workspaces then over a limit are brought
//     within it by the existing downgrade archive (never deleted).

import { AuthError } from '@/lib/auth/errors';
import { enforcePlanLimits } from '@/lib/billing/downgrade';
import { DEFAULT_PLAN } from '@/lib/billing/entitlements';
import { FEATURES, LIMITS } from '@/lib/billing/entitlements-catalogue';
import { billingConfigured } from '@/lib/billing/razorpay-billing';
import type { PlanPreview, PlatformAdmin, PlatformPlanPrice, PlatformPlanRow, PlatformPlanVersion } from '@/types/platform';
import {
  PlatformDbError,
  platformMovePlanSubscribers,
  platformPlanPreview,
  platformPlanPrices,
  platformPlans,
  platformPlanVersions,
  platformPublishPlanVersion,
} from './db';

export type PlanDraftErrorCode = 'invalid_plan_terms' | 'plan_locked' | 'unknown_plan' | 'invalid_request' | 'reason_required' | 'stale_version';

const STATUS: Record<PlanDraftErrorCode, number> = {
  invalid_plan_terms: 400, plan_locked: 403, unknown_plan: 404, invalid_request: 400, reason_required: 400, stale_version: 409,
};

/** A refusal with a fixed code, raised before any database call. */
export class PlanDraftError extends AuthError {
  constructor(readonly planCode: PlanDraftErrorCode) {
    super(planCode, STATUS[planCode], planCode);
    this.name = 'PlanDraftError';
  }
}

export interface PlanDraft {
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
}

const PLAN_ID = /^[a-z][a-z0-9_]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function assertPlanId(planId: string): string {
  if (!PLAN_ID.test(planId)) throw new PlanDraftError('unknown_plan');
  return planId;
}

/**
 * Validates and normalises a draft: every known feature (missing = off) and
 * every known limit (missing = unlimited), in catalogue order, so a preview and
 * its publish carry the identical JSON.
 */
export function parsePlanDraft(raw: unknown): PlanDraft {
  if (!isObject(raw) || !isObject(raw.features) || !isObject(raw.limits)) throw new PlanDraftError('invalid_plan_terms');
  const features: Record<string, boolean> = {};
  const limits: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(raw.features))
    if (!(FEATURES as readonly string[]).includes(key) || typeof value !== 'boolean') throw new PlanDraftError('invalid_plan_terms');
  for (const [key, value] of Object.entries(raw.limits))
    if (!(LIMITS as readonly string[]).includes(key) || (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)))
      throw new PlanDraftError('invalid_plan_terms');
  for (const f of FEATURES) features[f] = raw.features[f] === true;
  for (const k of LIMITS) limits[k] = typeof raw.limits[k] === 'number' ? (raw.limits[k] as number) : null;
  return { features, limits };
}

/** The enterprise lock: no finite limit and no feature that is on today turned off. */
export function assertPlanRules(planId: string, current: { features: Record<string, unknown> }, draft: PlanDraft): void {
  if (planId !== DEFAULT_PLAN) return;
  if (Object.values(draft.limits).some((v) => v !== null)) throw new PlanDraftError('plan_locked');
  for (const [key, on] of Object.entries(current.features))
    if (on === true && draft.features[key] !== true) throw new PlanDraftError('plan_locked');
}

export interface PlanCatalogue {
  plans: PlatformPlanRow[];
  prices: PlatformPlanPrice[];
  billingConfigured: boolean;
}

export async function planCatalogue(): Promise<PlanCatalogue> {
  const [plans, prices] = await Promise.all([platformPlans(), platformPlanPrices()]);
  return { plans, prices, billingConfigured: billingConfigured() };
}

async function currentPlan(planId: string): Promise<PlatformPlanRow> {
  const plan = (await platformPlans()).find((p) => p.id === assertPlanId(planId));
  if (!plan) throw new PlanDraftError('unknown_plan');
  return plan;
}

export async function planDetail(planId: string): Promise<{ plan: PlatformPlanRow; versions: PlatformPlanVersion[] }> {
  const plan = await currentPlan(planId);
  return { plan, versions: await platformPlanVersions(plan.id) };
}

/** What publishing `raw` would change: tightened limits and how many workspaces are already over them. */
export async function previewPlan(planId: string, raw: unknown): Promise<PlanPreview> {
  const plan = await currentPlan(planId);
  const draft = parsePlanDraft(raw);
  assertPlanRules(plan.id, plan, draft);
  return platformPlanPreview(plan.id, draft.features, draft.limits);
}

/** Publishes body { features, limits, note?, previewHash } as the next version; returns its number. */
export async function publishPlan(admin: PlatformAdmin, planId: string, raw: unknown): Promise<{ version: number }> {
  if (!isObject(raw)) throw new PlanDraftError('invalid_request');
  const plan = await currentPlan(planId);
  const draft = parsePlanDraft(raw);
  assertPlanRules(plan.id, plan, draft);
  const note = raw.note === undefined || raw.note === null || raw.note === '' ? null : raw.note;
  if (note !== null && (typeof note !== 'string' || note.trim().length > 500)) throw new PlanDraftError('invalid_request');
  if (typeof raw.previewHash !== 'string' || !HASH.test(raw.previewHash)) throw new PlanDraftError('invalid_request');
  const version = await platformPublishPlanVersion({
    planId: plan.id, features: draft.features, limits: draft.limits, note: note?.trim() || null, adminEmail: admin.email, previewHash: raw.previewHash,
  });
  return { version };
}

export interface MoveResult {
  version: number;
  moved: number;
  /** Workspaces where items beyond the new limits were archived. */
  archivedWorkspaces: number;
  /**
   * Workspaces whose archive step failed (rare: a database error). They are pinned already, so the
   * gates enforce the new limits on additions; items already over them stay active until the next
   * plan change of that workspace. Listed so an operator can follow up.
   */
  failedAccounts: string[];
}

/**
 * Body { reason, version }: re-pins every granting subscriber of the plan to
 * `version`, which must still be the plan's current version, then brings each
 * moved workspace within the new limits (archive, never delete).
 */
export async function moveSubscribers(admin: PlatformAdmin, planId: string, raw: unknown): Promise<MoveResult> {
  if (!isObject(raw)) throw new PlanDraftError('invalid_request');
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < 10 || reason.length > 500) throw new PlanDraftError('reason_required');
  const plan = await currentPlan(planId);
  if (raw.version !== plan.currentVersion) throw new PlanDraftError('stale_version');
  // The SQL re-checks the version under the plan lock (a publish in between -> stale_version).
  const pinned = await platformMovePlanSubscribers(plan.id, plan.currentVersion, admin.email, reason).catch((error: unknown) => {
    throw error instanceof PlatformDbError && error.platformCode === 'stale_version' ? new PlanDraftError('stale_version') : error;
  });
  let archivedWorkspaces = 0;
  const failedAccounts: string[] = [];
  // Every granting subscriber on the version, not only the ones moved now: archiving is
  // idempotent, so repeating a move finishes one an interrupted request left part-way.
  for (const { accountId } of pinned) {
    try {
      const result = await enforcePlanLimits(accountId);
      if (Object.values(result).some((r) => r.archived > 0)) archivedWorkspaces += 1;
    } catch (error) {
      failedAccounts.push(accountId);
      console.error('Plan limits after move failed', error instanceof Error ? error.name : 'unknown');
    }
  }
  return { version: plan.currentVersion, moved: pinned.filter((p) => p.changed).length, archivedWorkspaces, failedAccounts };
}
