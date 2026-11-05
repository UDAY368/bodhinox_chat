// Typed wrappers for every crm_platform_* function, through the platform
// console role (bodhinox_platform: EXECUTE on these functions only, no table
// grants). Callers have already passed requirePlatformAdmin; the admin email
// passed here is the session-verified one, never a request field.

import { AuthError } from '@/lib/auth/errors';
import { getPlatformPrisma } from '@/lib/db/prisma';
import {
  PLATFORM_DB_ERRORS,
  type LifecycleStatus,
  type PlanPreview,
  type PlatformAuditRow,
  type PlatformDbErrorCode,
  type PlatformIntegrationHealthRow,
  type PlatformJobBacklogRow,
  type PlatformPlanPrice,
  type PlatformPlanRow,
  type PlatformPlanVersion,
  type PlatformReconciliationItem,
  type PlatformSupportGrant,
  type PlatformTenantDetail,
  type PlatformTenantRow,
  type ReconciliationStatus,
  type SupportDiagnostics,
  type SupportGrantStatus,
} from '@/types/platform';

const STATUS: Record<PlatformDbErrorCode, number> = {
  unknown_plan: 404, unknown_account: 404, invalid_plan_terms: 400, plan_locked: 403, preview_mismatch: 409,
  reason_required: 400, note_required: 400, invalid_lifecycle_status: 400, lifecycle_closing: 409, invalid_duration: 400,
  support_request_open: 409, grant_not_active: 403, stale_version: 409,
};

/** A refusal raised inside a crm_platform_* function, with its fixed code. */
export class PlatformDbError extends AuthError {
  constructor(readonly platformCode: PlatformDbErrorCode) {
    super(platformCode, STATUS[platformCode], platformCode);
    this.name = 'PlatformDbError';
  }
}

/** Maps a database error raised by a crm_platform_* function to its code; anything else is rethrown unchanged. */
export function platformDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  const code = PLATFORM_DB_ERRORS.find((c) => new RegExp(`\\b${c}\\b`).test(message));
  if (code) throw new PlatformDbError(code);
  throw error;
}

async function call<T>(run: (db: ReturnType<typeof getPlatformPrisma>) => Promise<T>): Promise<T> {
  try {
    return await run(getPlatformPrisma());
  } catch (error) {
    return platformDbError(error);
  }
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0));
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const numbers = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([k, x]) => [k, num(x)]));

// ---------------------------------------------------------------- tenants
export async function platformTenants(input: { search?: string | null; cursor?: Date | null; limit?: number }): Promise<PlatformTenantRow[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM crm_platform_tenants(${input.search?.trim().slice(0, 200) || null}, ${input.cursor ?? null}::timestamptz, ${input.limit ?? 50}::int)`);
  return rows.map((r) => ({
    accountId: String(r.account_id), name: String(r.name), createdAt: iso(r.created_at),
    ownerEmail: (r.owner_email as string | null) ?? null, planId: String(r.plan_id),
    planVersion: r.plan_version == null ? null : num(r.plan_version), subscriptionStatus: (r.subscription_status as string | null) ?? null,
    lifecycleStatus: r.lifecycle_status as LifecycleStatus, blockManual: r.block_manual === true, purgeAfter: isoOrNull(r.purge_after),
    memberCount: num(r.member_count), usage: numbers(r.usage),
  }));
}

export async function platformTenant(accountId: string): Promise<PlatformTenantDetail | null> {
  const rows = await call((db) => db.$queryRaw<{ detail: PlatformTenantDetail | null }[]>`
    SELECT crm_platform_tenant(${accountId}::uuid) AS detail`);
  return rows[0]?.detail ?? null;
}

// ---------------------------------------------------------------- health
export async function platformIntegrationHealth(platformKeyId: string | null): Promise<PlatformIntegrationHealthRow[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM crm_platform_integration_health(${platformKeyId || null})`);
  return rows.map((r) => ({
    accountId: String(r.account_id), accountName: String(r.account_name),
    disconnectedNumbers: num(r.disconnected_numbers), numberHealthErrors: num(r.number_health_errors),
    instagramAttention: num(r.instagram_attention), metaAdsAttention: num(r.meta_ads_attention),
    meetingsAttention: num(r.meetings_attention), courierAttention: num(r.courier_attention),
    tokensExpiring: num(r.tokens_expiring), sharedRazorpayKey: r.shared_razorpay_key === true,
  }));
}

export async function platformJobBacklog(): Promise<PlatformJobBacklogRow[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM crm_platform_job_backlog()`);
  return rows.map((r) => ({
    source: r.source as PlatformJobBacklogRow['source'], type: String(r.type), status: String(r.status),
    workspaces: r.workspaces == null ? null : num(r.workspaces), items: num(r.items), oldest: isoOrNull(r.oldest),
  }));
}

// ---------------------------------------------------------------- reconciliation
/** Items newest first; `cursorAt` (full precision) and `id` of the last item fetch the next page. */
export async function platformReconciliationList(input: { status?: ReconciliationStatus | null;
  cursor?: { at: string; id: string } | null; limit?: number }): Promise<(PlatformReconciliationItem & { cursorAt: string })[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM crm_platform_reconciliation_list(${input.status ?? null}, ${input.cursor?.at ?? null}::timestamptz,
      ${input.cursor?.id ?? null}::uuid, ${input.limit ?? 50}::int)`);
  return rows.map((r) => ({
    cursorAt: String(r.cursor_at),
    id: String(r.id), accountId: (r.account_id as string | null) ?? null, accountName: (r.account_name as string | null) ?? null,
    kind: r.kind as PlatformReconciliationItem['kind'], sourceRef: String(r.source_ref), detail: (r.detail ?? {}) as Record<string, unknown>,
    status: r.status as ReconciliationStatus, openedAt: iso(r.opened_at), resolvedAt: isoOrNull(r.resolved_at),
    resolvedByEmail: (r.resolved_by_email as string | null) ?? null, resolutionNote: (r.resolution_note as string | null) ?? null,
  }));
}

/** False when the item is unknown or already resolved. */
export async function platformReconciliationResolve(id: string, adminEmail: string, note: string): Promise<boolean> {
  const rows = await call((db) => db.$queryRaw<{ ok: boolean }[]>`
    SELECT crm_platform_reconciliation_resolve(${id}::uuid, ${adminEmail}, ${note}) AS ok`);
  return rows[0]?.ok === true;
}

/** Queues billing.lifecycle_sweep for the workspace; false when it has no provider subscription. */
export async function platformBillingRefetch(accountId: string, adminEmail: string, reason: string | null): Promise<boolean> {
  const rows = await call((db) => db.$queryRaw<{ ok: boolean }[]>`
    SELECT crm_platform_billing_refetch(${accountId}::uuid, ${adminEmail}, ${reason}) AS ok`);
  return rows[0]?.ok === true;
}

// ---------------------------------------------------------------- plans
export async function platformPlans(): Promise<PlatformPlanRow[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM crm_platform_plans()`);
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), sort: num(r.sort), currentVersion: num(r.current_version),
    features: (r.features ?? {}) as Record<string, unknown>, limits: (r.limits ?? {}) as Record<string, unknown>,
    subscribers: num(r.subscribers), pinnedOld: num(r.pinned_old),
  }));
}

export async function platformPlanVersions(planId: string): Promise<PlatformPlanVersion[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM crm_platform_plan_versions(${planId})`);
  return rows.map((r) => ({
    id: String(r.id), version: num(r.version), features: (r.features ?? {}) as Record<string, unknown>,
    limits: (r.limits ?? {}) as Record<string, unknown>, note: (r.note as string | null) ?? null,
    createdByEmail: (r.created_by_email as string | null) ?? null, createdAt: iso(r.created_at),
  }));
}

export async function platformPlanPrices(): Promise<PlatformPlanPrice[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM crm_platform_plan_prices()`);
  return rows.map((r) => ({
    plan: String(r.plan), interval: r.interval as PlatformPlanPrice['interval'], currency: String(r.currency),
    amountMinor: num(r.amount_minor), providerPlanId: String(r.provider_plan_id), active: r.active === true,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  }));
}

export async function platformPlanPreview(planId: string, features: Record<string, unknown>, limits: Record<string, unknown>): Promise<PlanPreview> {
  const rows = await call((db) => db.$queryRaw<{ preview: PlanPreview }[]>`
    SELECT crm_platform_plan_preview(${planId}, ${JSON.stringify(features)}::jsonb, ${JSON.stringify(limits)}::jsonb) AS preview`);
  return rows[0].preview;
}

/** Returns the new version number. */
export async function platformPublishPlanVersion(input: { planId: string; features: Record<string, unknown>; limits: Record<string, unknown>;
  note: string | null; adminEmail: string; previewHash: string }): Promise<number> {
  const rows = await call((db) => db.$queryRaw<{ version: number }[]>`
    SELECT crm_platform_publish_plan_version(${input.planId}, ${JSON.stringify(input.features)}::jsonb,
      ${JSON.stringify(input.limits)}::jsonb, ${input.note}, ${input.adminEmail}, ${input.previewHash}) AS version`);
  return num(rows[0].version);
}

/**
 * Re-pins every subscription of the plan to `version`, which must still be its current version
 * ('stale_version' otherwise, checked under the plan lock). Returns every granting subscriber on
 * that version, `changed` for the ones this call moved.
 */
export async function platformMovePlanSubscribers(planId: string, version: number, adminEmail: string, reason: string):
  Promise<{ accountId: string; changed: boolean }[]> {
  const rows = await call((db) => db.$queryRaw<{ account_id: string; changed: boolean }[]>`
    SELECT account_id, changed FROM crm_platform_move_plan_subscribers(${planId}, ${version}::int, ${adminEmail}, ${reason})`);
  return rows.map((r) => ({ accountId: String(r.account_id), changed: r.changed === true }));
}

// ---------------------------------------------------------------- lifecycle and support
export async function platformSetLifecycle(input: { accountId: string; status: Exclude<LifecycleStatus, 'closing'>; blockManual: boolean;
  reason: string; adminEmail: string }): Promise<void> {
  // Returns void, which $queryRaw cannot deserialize.
  await call((db) => db.$executeRaw`
    SELECT crm_platform_set_lifecycle(${input.accountId}::uuid, ${input.status}, ${input.blockManual}, ${input.reason}, ${input.adminEmail})`);
}

/** Returns the new grant id. */
export async function platformSupportRequest(input: { accountId: string; adminEmail: string; reason: string; minutes: number }): Promise<string> {
  const rows = await call((db) => db.$queryRaw<{ id: string }[]>`
    SELECT crm_platform_support_request(${input.accountId}::uuid, ${input.adminEmail}, ${input.reason}, ${input.minutes}::int) AS id`);
  return String(rows[0].id);
}

export async function platformSupportGrants(adminEmail: string, accountId: string | null = null): Promise<PlatformSupportGrant[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM crm_platform_support_grants(${adminEmail}, ${accountId}::uuid)`);
  return rows.map((r) => ({
    id: String(r.id), accountId: String(r.account_id), accountName: String(r.account_name), reason: String(r.reason),
    requestedMinutes: num(r.requested_minutes), status: r.status as SupportGrantStatus, requestedAt: iso(r.requested_at),
    decidedAt: isoOrNull(r.decided_at), expiresAt: isoOrNull(r.expires_at),
  }));
}

/** Throws PlatformDbError('grant_not_active') unless the caller's grant is approved and unexpired. */
export async function platformSupportDiagnostics(grantId: string, adminEmail: string): Promise<SupportDiagnostics> {
  const rows = await call((db) => db.$queryRaw<{ dto: SupportDiagnostics }[]>`
    SELECT crm_platform_support_diagnostics(${grantId}::uuid, ${adminEmail}) AS dto`);
  return rows[0].dto;
}

// ---------------------------------------------------------------- audit
export async function platformAuditList(input: { accountId?: string | null; cursor?: Date | null; limit?: number }): Promise<PlatformAuditRow[]> {
  const rows = await call((db) => db.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM crm_platform_audit_list(${input.accountId ?? null}::uuid, ${input.cursor ?? null}::timestamptz, ${input.limit ?? 50}::int)`);
  return rows.map((r) => ({
    id: String(r.id), adminEmail: String(r.admin_email), action: String(r.action), targetAccountId: (r.target_account_id as string | null) ?? null,
    targetRef: (r.target_ref as string | null) ?? null, reason: (r.reason as string | null) ?? null,
    detail: (r.detail ?? {}) as Record<string, unknown>, createdAt: iso(r.created_at),
  }));
}
