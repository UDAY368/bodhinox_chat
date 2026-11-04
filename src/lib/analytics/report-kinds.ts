// Report kinds, formats and the lowest role each kind's data is visible to.
// Pure (no database or server imports), so the reports UI can share it.

export const REPORT_KINDS = [
  'campaign_daily', 'campaign_summary', 'member_campaigns', 'agent_performance',
  'product_summary', 'service_summary', 'commerce_daily',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export type ShareRole = 'viewer' | 'agent' | 'admin';
export const SHARE_ROLES: readonly ShareRole[] = ['viewer', 'agent', 'admin'];

/**
 * The lowest role that sees each kind's data on the live analytics endpoints
 * (campaigns, agents and appointment stats for viewers; commerce for agents).
 * Requesting and downloading reports still require admin; this bounds sharing
 * only: a share's min_role can never be below it.
 */
export const KIND_MIN_ROLE: Record<ReportKind, ShareRole> = {
  campaign_daily: 'viewer',
  campaign_summary: 'viewer',
  member_campaigns: 'viewer',
  agent_performance: 'viewer',
  service_summary: 'viewer',
  product_summary: 'agent',
  commerce_daily: 'agent',
};

const RANK: Record<ShareRole, number> = { viewer: 0, agent: 1, admin: 2 };

/** The share roles allowed for a kind (at least its live minimum). */
export function shareRolesFor(kind: ReportKind): ShareRole[] {
  return SHARE_ROLES.filter((role) => RANK[role] >= RANK[KIND_MIN_ROLE[kind]]);
}

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value);
}

export function isReportFormat(value: unknown): value is ReportFormat {
  return value === 'csv' || value === 'pdf';
}
