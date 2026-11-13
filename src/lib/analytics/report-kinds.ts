// Report kinds, formats and the lowest role each kind's data is visible to.
// Pure (no database or server imports), so the reports UI can share it.

/** Kinds a member can request or schedule by name (each has a fixed layout). */
export const REPORT_KINDS = [
  'campaign_daily', 'campaign_summary', 'member_campaigns', 'agent_performance',
  'product_summary', 'service_summary', 'commerce_daily',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * A run built from a saved report definition (analytics_saved_reports): its
 * metrics, grouping and channel travel in the run's params. Only a saved
 * report's schedule produces it, never a direct request.
 */
export const SAVED_REPORT_KIND = 'saved_report' as const;
/** Every kind a report_runs or report_schedules row can hold. */
export const RUN_KINDS = [...REPORT_KINDS, SAVED_REPORT_KIND] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const REPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type ShareRole = 'viewer' | 'agent' | 'admin';
export const SHARE_ROLES: readonly ShareRole[] = ['viewer', 'agent', 'admin'];

/**
 * The lowest role that sees each kind's data on the live analytics endpoints
 * (campaigns, agents and appointment stats for viewers; commerce for agents).
 * Requesting and downloading reports still require admin; this bounds sharing
 * only: a share's min_role can never be below it. Saved reports hold
 * conversation, message and member counts, which viewers see live.
 */
export const KIND_MIN_ROLE: Record<RunKind, ShareRole> = {
  campaign_daily: 'viewer',
  campaign_summary: 'viewer',
  member_campaigns: 'viewer',
  agent_performance: 'viewer',
  service_summary: 'viewer',
  product_summary: 'agent',
  commerce_daily: 'agent',
  saved_report: 'viewer',
};

const RANK: Record<ShareRole, number> = { viewer: 0, agent: 1, admin: 2 };

/** The share roles allowed for a kind (at least its live minimum). */
export function shareRolesFor(kind: RunKind): ShareRole[] {
  return SHARE_ROLES.filter((role) => RANK[role] >= RANK[KIND_MIN_ROLE[kind]]);
}

/** A kind that can be requested or scheduled by name. */
export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

/** Any kind a stored run or schedule may carry. */
export function isRunKind(value: unknown): value is RunKind {
  return typeof value === 'string' && (RUN_KINDS as readonly string[]).includes(value);
}

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'csv' || value === 'pdf';
}
