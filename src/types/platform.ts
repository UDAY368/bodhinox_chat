// Platform console (Phase 14) data shapes. Every one mirrors the fixed columns
// a crm_platform_* function returns: ids, names, counts, statuses and error
// codes only; never message bodies, contact fields, secrets or tokens.

export type LifecycleStatus = 'active' | 'admin_suspended' | 'closing';
export type SupportGrantStatus = 'requested' | 'approved' | 'denied' | 'revoked' | 'expired';
export type ReconciliationKind = 'event_error' | 'intent_unknown' | 'invoice_unissued' | 'state_mismatch' | 'shared_razorpay_key';
export type ReconciliationStatus = 'open' | 'resolved';

/** The signed-in, allowlisted, MFA-verified platform admin. */
export interface PlatformAdmin {
  userId: string;
  sessionId: string;
  email: string;
}

export interface PlatformTenantRow {
  accountId: string;
  name: string;
  createdAt: string;
  ownerEmail: string | null;
  /** The plan the workspace resolves to (enterprise without a subscription, free when not granting). */
  planId: string;
  planVersion: number | null;
  subscriptionStatus: string | null;
  lifecycleStatus: LifecycleStatus;
  blockManual: boolean;
  /** Set while closing; past it the workspace is listed as "purge due" (purged when WORKSPACE_PURGE_ENABLED=true). */
  purgeAfter: string | null;
  memberCount: number;
  /** Stored usage_counters for the current IST month (metric -> value). */
  usage: Record<string, number>;
}

export interface PlatformTenantDetail {
  account_id: string;
  name: string;
  created_at: string;
  owner_email: string | null;
  plan_id: string;
  plan_version: number | null;
  subscription: {
    plan_id: string;
    status: string;
    interval: string | null;
    provider: string | null;
    has_provider_subscription: boolean;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    scheduled_plan: string | null;
    grace_ends_at: string | null;
    suspended_at: string | null;
  } | null;
  lifecycle: {
    status: LifecycleStatus;
    block_manual: boolean;
    suspended_at: string | null;
    suspend_reason: string | null;
    suspended_by_email: string | null;
    deletion_requested_at: string | null;
    purge_after: string | null;
  };
  members: Record<string, number>;
  usage: Record<string, number>;
  open_reconciliation_items: number;
  support_grants: { id: string; requested_by_email: string; status: SupportGrantStatus; requested_at: string; expires_at: string | null }[];
}

export interface PlatformIntegrationHealthRow {
  accountId: string;
  accountName: string;
  disconnectedNumbers: number;
  numberHealthErrors: number;
  instagramAttention: number;
  metaAdsAttention: number;
  meetingsAttention: number;
  courierAttention: number;
  tokensExpiring: number;
  sharedRazorpayKey: boolean;
}

export interface PlatformJobBacklogRow {
  source: 'jobs' | 'webhook_receipts';
  type: string;
  status: string;
  workspaces: number | null;
  items: number;
  oldest: string | null;
}

export interface PlatformReconciliationItem {
  id: string;
  accountId: string | null;
  accountName: string | null;
  kind: ReconciliationKind;
  sourceRef: string;
  detail: Record<string, unknown>;
  status: ReconciliationStatus;
  openedAt: string;
  resolvedAt: string | null;
  resolvedByEmail: string | null;
  resolutionNote: string | null;
}

export interface PlatformPlanRow {
  id: string;
  name: string;
  sort: number;
  currentVersion: number;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  subscribers: number;
  /** Granting subscriptions pinned to an older version than the current one. */
  pinnedOld: number;
}

export interface PlatformPlanVersion {
  id: string;
  version: number;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  note: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface PlatformPlanPrice {
  plan: string;
  interval: 'month' | 'year';
  currency: string;
  amountMinor: number;
  providerPlanId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlanPreview {
  plan: string;
  current_version: number;
  /** Workspaces resolving to the live row (no row -> enterprise, non-granting -> free, granting but unpinned). */
  affected_workspaces: number;
  /** Each tightened finite limit; `over` is null for soft and per-campaign limits. */
  tightened: { key: string; current: number | null; next: number; over: number | null }[];
  /** Echo in the publish body; a different draft or a newer version answers 409. */
  preview_hash: string;
}

export interface PlatformSupportGrant {
  id: string;
  accountId: string;
  accountName: string;
  reason: string;
  requestedMinutes: number;
  status: SupportGrantStatus;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

/** crm_platform_support_diagnostics: statuses, counts and error codes for one workspace. */
export interface SupportDiagnostics {
  account_id: string;
  grant_id: string;
  expires_at: string;
  subscription: { plan_id: string; status: string; current_period_end: string | null; cancel_at_period_end: boolean; has_provider_subscription: boolean } | null;
  lifecycle: { status: LifecycleStatus; block_manual: boolean } | null;
  usage: Record<string, number>;
  whatsapp_numbers: { id: string; status: string; quality_rating: string | null; messaging_limit_tier: string | null; has_token: boolean;
    health_checked_at: string | null; health_error_at: string | null; registered: boolean }[];
  integrations: {
    instagram: { status: string; last_error_code: string | null; token_expires_at: string | null; last_webhook_at: string | null }[];
    meta_ads: { status: string; last_error_code: string | null; token_expires_at: string | null }[];
    meetings: { provider: string; status: string; last_error_code: string | null; token_expires_at: string | null }[];
    courier: { provider: string; status: string; last_error_code: string | null }[];
    shopify: number;
    woocommerce: number;
    razorpay_commerce: { mode: string; connected_at: string | null }[];
  };
  failed_jobs: { type: string; count: number; last_at: string }[];
  outbound_intents: Record<string, number>;
  billing_intents: Record<string, number>;
  open_payment_exceptions: number;
  open_reconciliation_items: number;
  settings: { ai_summaries: boolean; ai_suggestions: boolean; ai_assessment: boolean; ai_insights: boolean; ai_monthly_token_cap: number | null } | null;
}

export interface PlatformAuditRow {
  id: string;
  adminEmail: string;
  action: string;
  targetAccountId: string | null;
  targetRef: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

/** Error codes the crm_platform_* functions raise (as the exception message). */
export const PLATFORM_DB_ERRORS = ['unknown_plan', 'invalid_plan_terms', 'plan_locked', 'preview_mismatch', 'reason_required',
  'note_required', 'unknown_account', 'invalid_lifecycle_status', 'lifecycle_closing', 'invalid_duration',
  'support_request_open', 'grant_not_active', 'stale_version'] as const;
export type PlatformDbErrorCode = (typeof PLATFORM_DB_ERRORS)[number];
