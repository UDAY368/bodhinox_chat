// Permission-controlled report sharing (Phase 12 design §5.5).
//
// An admin shares one ready report with members of the same workspace at or
// above a minimum role, for at most seven days and never past the report's own
// expiry. A share carries no token: its link holds only the share id, and
// opening it requires a live session in the share's workspace whose live role
// meets min_role. The SECURITY DEFINER function crm_open_report_share enforces
// workspace, role, expiry and revocation in SQL and counts the open; the open
// is also audit-logged. A share's min_role can never be below the lowest role
// that sees the same data live (KIND_MIN_ROLE). Anything that does not open
// (unknown, malformed, other workspace, role too low, expired, revoked, report
// expired) is a uniform not_found.

import { Prisma } from '@prisma/client';
import { hasMinRole, roleRank, type AccountRole } from '@/lib/auth/roles';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { isRunKind, KIND_MIN_ROLE, SHARE_ROLES, type ReportFormat, type RunKind, type ShareRole } from './report-kinds';
import { reportFilename, validParams } from './reports';

export { SHARE_ROLES, type ShareRole };
export const MAX_SHARE_HOURS = 168;
export const SHARE_LIST_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ShareError extends Error {
  constructor(public readonly code: 'invalid' | 'role_too_low' | 'not_found' | 'not_ready', public readonly status: number) {
    super(code);
    this.name = 'ShareError';
  }
}

export interface ShareActor {
  accountId: string;
  userId: string;
  role: AccountRole;
}

export interface ReportShare {
  id: string;
  reportId: string;
  minRole: ShareRole;
  path: string;
  createdBy: { userId: string; name: string | null };
  expiresAt: string;
  revokedAt: string | null;
  openCount: number;
  lastOpenedAt: string | null;
  createdAt: string;
}

export const isShareRole = (value: unknown): value is ShareRole => typeof value === 'string' && (SHARE_ROLES as readonly string[]).includes(value);

/** A share role is allowed for a kind when it is at least the kind's live minimum. */
export function shareRoleAllowed(kind: RunKind, minRole: ShareRole): boolean {
  return roleRank(minRole) >= roleRank(KIND_MIN_ROLE[kind]);
}

/** The in-app path of a share; the URL adds APP_URL when it is configured. */
export const sharePath = (shareId: string) => `/reports/shared/${shareId}`;

export function shareUrl(shareId: string): string | null {
  const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!origin) return null;
  try {
    return new URL(sharePath(shareId), origin).toString();
  } catch {
    return null;
  }
}

function assertAdmin(actor: ShareActor): void {
  if (!hasMinRole(actor.role, 'admin')) throw new ShareError('not_found', 404);
}

const audit = (tx: TenantTransaction, actor: ShareActor, action: string, resourceId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${actor.accountId}::uuid,${actor.userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;

type ShareRow = {
  id: string; report_run_id: string; min_role: ShareRole; created_by: string; creator_name: string | null; expires_at: Date;
  revoked_at: Date | null; open_count: number; last_opened_at: Date | null; created_at: Date;
};

const toShare = (r: ShareRow): ReportShare => ({
  id: r.id, reportId: r.report_run_id, minRole: r.min_role, path: sharePath(r.id),
  createdBy: { userId: r.created_by, name: r.creator_name }, expiresAt: r.expires_at.toISOString(),
  revokedAt: r.revoked_at?.toISOString() ?? null, openCount: r.open_count, lastOpenedAt: r.last_opened_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

const shareSelect = (accountId: string) => Prisma.sql`SELECT s.id::text AS id, s.report_run_id::text AS report_run_id, s.min_role,
  s.created_by::text AS created_by, (SELECT p.full_name FROM profiles p WHERE p.user_id=s.created_by LIMIT 1) AS creator_name,
  s.expires_at, s.revoked_at, s.open_count, s.last_opened_at, s.created_at FROM report_shares s WHERE s.account_id=${accountId}::uuid`;

/** Shares one ready report. expires_at is now + hours, capped at the report's own expiry. */
export async function createShare(actor: ShareActor, reportId: string, input: { minRole: unknown; expiresInHours: unknown }): Promise<ReportShare & { url: string | null }> {
  assertAdmin(actor);
  if (!UUID.test(reportId)) throw new ShareError('not_found', 404);
  const hours = input.expiresInHours;
  if (!isShareRole(input.minRole) || !Number.isInteger(hours) || (hours as number) < 1 || (hours as number) > MAX_SHARE_HOURS)
    throw new ShareError('invalid', 400);
  const minRole = input.minRole;
  return withTenant(actor, async (tx) => {
    const runs = await tx.$queryRaw<{ kind: string; status: string; live: boolean }[]>`SELECT kind, status, expires_at > now() AS live
      FROM report_runs WHERE account_id=${actor.accountId}::uuid AND id=${reportId}::uuid`;
    const run = runs[0];
    if (!run || !isRunKind(run.kind)) throw new ShareError('not_found', 404);
    if (run.status !== 'ready' || !run.live) throw new ShareError('not_ready', 409);
    if (!shareRoleAllowed(run.kind, minRole)) throw new ShareError('role_too_low', 400);
    const inserted = await tx.$queryRaw<{ id: string }[]>`INSERT INTO report_shares(account_id,report_run_id,min_role,created_by,expires_at)
      SELECT ${actor.accountId}::uuid, r.id, ${minRole}, ${actor.userId}::uuid,
        LEAST(now() + make_interval(hours => ${hours as number}::int), r.expires_at)
      FROM report_runs r WHERE r.account_id=${actor.accountId}::uuid AND r.id=${reportId}::uuid
      RETURNING id::text AS id`;
    const id = inserted[0].id;
    const rows = await tx.$queryRaw<ShareRow[]>(Prisma.sql`${shareSelect(actor.accountId)} AND s.id=${id}::uuid`);
    await audit(tx, actor, 'analytics.report_shared', reportId, { share_id: id, min_role: minRole, expires_at: rows[0].expires_at.toISOString() });
    return { ...toShare(rows[0]), url: shareUrl(id) };
  });
}

/** A report's shares, newest first (admins and owners). */
export async function listShares(actor: ShareActor, reportId: string): Promise<ReportShare[]> {
  assertAdmin(actor);
  if (!UUID.test(reportId)) throw new ShareError('not_found', 404);
  const rows = await withTenant(actor, (tx) => tx.$queryRaw<ShareRow[]>(Prisma.sql`${shareSelect(actor.accountId)}
    AND s.report_run_id=${reportId}::uuid ORDER BY s.created_at DESC, s.id LIMIT ${SHARE_LIST_LIMIT}`));
  return rows.map(toShare);
}

/** Revokes a share (idempotent for an already revoked one); not_found for anything else. */
export async function revokeShare(actor: ShareActor, reportId: string, shareId: string): Promise<void> {
  assertAdmin(actor);
  if (!UUID.test(reportId) || !UUID.test(shareId)) throw new ShareError('not_found', 404);
  await withTenant(actor, async (tx) => {
    const rows = await tx.$queryRaw<{ revoked: boolean }[]>`UPDATE report_shares SET revoked_at=COALESCE(revoked_at, now())
      WHERE account_id=${actor.accountId}::uuid AND id=${shareId}::uuid AND report_run_id=${reportId}::uuid
      RETURNING revoked_at IS NOT NULL AS revoked`;
    if (!rows[0]) throw new ShareError('not_found', 404);
    await audit(tx, actor, 'analytics.report_share_revoked', reportId, { share_id: shareId });
  });
}

/**
 * Opens a share for the live session (any role): the definer function checks
 * workspace, live role, expiry and revocation and counts the open; the open
 * is audited in the same transaction. Returns the private object key.
 */
export async function openShare(session: ShareActor, shareId: string): Promise<{ objectKey: string; filename: string; format: ReportFormat }> {
  if (!UUID.test(shareId)) throw new ShareError('not_found', 404);
  return withTenant(session, async (tx) => {
    const rows = await tx.$queryRaw<{ run_id: string; object_key: string; kind: string; format: string; params: unknown }[]>`
      SELECT run_id::text AS run_id, object_key, kind, format, params FROM crm_open_report_share(${shareId}::uuid)`;
    const row = rows[0];
    const params = row ? validParams(row.params) : null;
    if (!row || !isRunKind(row.kind) || !params) throw new ShareError('not_found', 404);
    const format: ReportFormat = row.format === 'pdf' ? 'pdf' : 'csv';
    await audit(tx, session, 'analytics.report_share_opened', row.run_id, { share_id: shareId, kind: row.kind, format });
    return { objectKey: row.object_key, filename: reportFilename(row.kind, params, format), format };
  });
}

export interface SharePeek {
  kind: RunKind;
  format: ReportFormat;
  /** When the share stops opening: the earlier of the share's and the report's expiry. */
  expiresAt: string;
}

/**
 * What a share is and until when it opens, for the live session, without
 * counting an open: crm_peek_report_share applies the same checks as
 * crm_open_report_share and returns no object key. Anything that would not
 * open is the same not_found.
 */
export async function peekShare(session: ShareActor, shareId: string): Promise<SharePeek> {
  if (!UUID.test(shareId)) throw new ShareError('not_found', 404);
  return withTenant(session, async (tx) => {
    const rows = await tx.$queryRaw<{ kind: string; format: string; expires_at: Date }[]>`
      SELECT kind, format, expires_at FROM crm_peek_report_share(${shareId}::uuid)`;
    const row = rows[0];
    if (!row || !isRunKind(row.kind)) throw new ShareError('not_found', 404);
    return { kind: row.kind, format: row.format === 'pdf' ? 'pdf' : 'csv', expiresAt: new Date(row.expires_at).toISOString() };
  });
}
