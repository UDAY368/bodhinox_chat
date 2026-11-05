// Workspace deletion request (Phase 14, Settings -> Privacy & access).
//
// Owner only, with step-up: the current password (or a Google sign-in on this
// session in the last few minutes for an account without one) plus the
// authenticator or a recovery code when the owner has MFA. The request sets
// account_lifecycle to 'closing' with purge_after = now() + 30 days; sends stop
// like a billing suspension (isSuspended reads the lifecycle row), inbound,
// opt-outs and payment webhooks keep working. Nothing is deleted: there is no
// purge job in Phase 14, the console lists workspaces past purge_after as
// "purge due". When platform billing is configured and the workspace has a
// provider subscription, it is cancelled at period end through the existing
// requestCancel intent path; its outcome never undoes the request.
//
// The owner can cancel the request during the grace period. A cancelled
// request does not resume a provider subscription that was set to cancel
// (resume is unsupported); the owner chooses a plan again from Billing.

import { NextResponse } from 'next/server';

import { getAuthPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { checkMfa, confirmIdentity } from '@/lib/auth/mfa';
import { toErrorResponse } from '@/lib/auth/account';
import { AuthError } from '@/lib/auth/errors';
import { ContractError } from '@/lib/data/contracts';
import type { AuthContext } from '@/lib/auth/session';
import { hasMinRole } from '@/lib/auth/roles';
import { billingConfigured } from '@/lib/billing/razorpay-billing';
import { BillingError, requestCancel } from '@/lib/billing/subscriptions';

/** A refusal with a stable code the UI translates. */
export class AccountActionError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = 'AccountActionError';
  }
}

/**
 * The JSON error for the account privacy routes: a stable `code` the UI translates
 * (step-up refusals keep the identity service's codes, e.g. mfa_required). Unknown
 * errors become a bare 500; nothing from them is logged beyond the error name.
 */
export function accountActionResponse(error: unknown): NextResponse {
  if (error instanceof AccountActionError)
    return NextResponse.json({ error: error.code, code: error.code }, { status: error.status });
  if (error instanceof AuthError)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof ContractError && error.status >= 400 && error.status < 500)
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

/** Days between a deletion request and the earliest purge (purge itself is not built yet). */
export const DELETION_GRACE_DAYS = 30;

/**
 * Re-confirms the caller in one identity-role transaction: the password (or a recent
 * Google sign-in) when `identity` is true, and the authenticator or a recovery code
 * whenever the user has MFA (replay-protected). Returns whether MFA was checked.
 */
export async function confirmStepUp(
  context: AuthContext,
  input: { password?: string; mfaCode?: string },
  options: { identity: boolean },
): Promise<boolean> {
  return getAuthPrisma().$transaction(async (tx) => {
    if (options.identity) await confirmIdentity(tx, context, input.password);
    return checkMfa(tx, context.userId, input.mfaCode);
  });
}

export interface WorkspaceLifecycle {
  status: 'active' | 'admin_suspended' | 'closing';
  deletionRequestedAt: string | null;
  purgeAfter: string | null;
}

type LifecycleRow = { status: WorkspaceLifecycle['status']; deletion_requested_at: Date | null; purge_after: Date | null };

const toLifecycle = (row: LifecycleRow | undefined): WorkspaceLifecycle => ({
  status: row?.status ?? 'active',
  deletionRequestedAt: row?.deletion_requested_at?.toISOString() ?? null,
  purgeAfter: row?.purge_after?.toISOString() ?? null,
});

const tenant = (context: AuthContext) => ({ accountId: context.accountId, userId: context.userId, role: context.role });

/** The workspace's lifecycle (no row = active). Any member may read it. */
export async function getWorkspaceLifecycle(context: AuthContext): Promise<WorkspaceLifecycle> {
  const rows = await withTenant(tenant(context), (tx) => tx.$queryRaw<LifecycleRow[]>`
    SELECT status, deletion_requested_at, purge_after FROM account_lifecycle WHERE account_id=${context.accountId}::uuid`);
  return toLifecycle(rows[0]);
}

export type BillingCancelOutcome = 'none' | 'scheduled' | 'pending' | 'failed';

/** Requests deletion of the caller's workspace (owner, step-up). Idempotent while closing. */
export async function requestWorkspaceDeletion(
  context: AuthContext,
  input: { password?: string; mfaCode?: string },
): Promise<WorkspaceLifecycle & { billingCancel: BillingCancelOutcome }> {
  if (!hasMinRole(context.role, 'owner')) throw new AccountActionError('owner_required', 403);
  await confirmStepUp(context, input, { identity: true });
  const lifecycle = await withTenant(tenant(context), async (tx) => {
    // Serialises concurrent requests (a row lock is not available: an admin-suspended
    // row is outside the owner's UPDATE policy). The UPDATE below re-checks the status.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workspace-lifecycle:${context.accountId}`}, 0))`;
    const current = await tx.$queryRaw<LifecycleRow[]>`
      SELECT status, deletion_requested_at, purge_after FROM account_lifecycle
      WHERE account_id=${context.accountId}::uuid`;
    if (current[0]?.status === 'admin_suspended') throw new AccountActionError('workspace_admin_suspended', 409);
    if (current[0]?.status === 'closing') return { row: current[0], created: false };
    const rows = current[0]
      ? await tx.$queryRaw<LifecycleRow[]>`
          UPDATE account_lifecycle SET status='closing', deletion_requested_at=now(), deletion_requested_by=${context.userId}::uuid,
            purge_after=now() + make_interval(days => ${DELETION_GRACE_DAYS}::int), updated_at=now()
          WHERE account_id=${context.accountId}::uuid AND status='active'
          RETURNING status, deletion_requested_at, purge_after`
      : await tx.$queryRaw<LifecycleRow[]>`
          INSERT INTO account_lifecycle(account_id, status, deletion_requested_at, deletion_requested_by, purge_after)
          VALUES (${context.accountId}::uuid, 'closing', now(), ${context.userId}::uuid, now() + make_interval(days => ${DELETION_GRACE_DAYS}::int))
          RETURNING status, deletion_requested_at, purge_after`;
    if (!rows[0]) throw new AccountActionError('deletion_unavailable', 409);
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${context.accountId}::uuid,${context.userId}::uuid,'workspace.deletion_requested',${context.accountId},
        ${JSON.stringify({ via: 'settings', grace_days: DELETION_GRACE_DAYS })}::jsonb)`;
    return { row: rows[0], created: true };
  });
  return { ...toLifecycle(lifecycle.row), billingCancel: await cancelBilling(context) };
}

/** Cancels the paid plan at period end through the existing intent path; never throws. */
async function cancelBilling(context: AuthContext): Promise<BillingCancelOutcome> {
  if (!billingConfigured()) return 'none';
  try {
    const result = await requestCancel({ accountId: context.accountId, userId: context.userId });
    return result.state === 'scheduled' || result.state === 'done' ? 'scheduled' : 'pending';
  } catch (error) {
    if (error instanceof BillingError && error.billingCode === 'no_subscription') return 'none';
    if (error instanceof BillingError && error.billingCode === 'change_pending') return 'pending';
    // Category only: provider errors can carry request details.
    console.error('[workspace-deletion] billing cancel failed', error instanceof BillingError ? error.billingCode : 'unexpected');
    return 'failed';
  }
}

/** Cancels a pending deletion request (owner). */
export async function cancelWorkspaceDeletion(context: AuthContext): Promise<WorkspaceLifecycle> {
  if (!hasMinRole(context.role, 'owner')) throw new AccountActionError('owner_required', 403);
  return withTenant(tenant(context), async (tx) => {
    const rows = await tx.$queryRaw<LifecycleRow[]>`
      UPDATE account_lifecycle SET status='active', deletion_requested_at=NULL, deletion_requested_by=NULL, purge_after=NULL, updated_at=now()
      WHERE account_id=${context.accountId}::uuid AND status='closing' AND suspend_reason IS NULL
      RETURNING status, deletion_requested_at, purge_after`;
    if (!rows[0]) {
      // A platform admin's hold on a closing workspace: only Bodhinox support can lift it.
      const [held] = await tx.$queryRaw<{ held: boolean }[]>`SELECT status='closing' AND suspend_reason IS NOT NULL AS held
        FROM account_lifecycle WHERE account_id=${context.accountId}::uuid`;
      throw held?.held ? new AccountActionError('workspace_admin_suspended', 409) : new AccountActionError('no_deletion_request', 409);
    }
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${context.accountId}::uuid,${context.userId}::uuid,'workspace.deletion_cancelled',${context.accountId},'{}'::jsonb)`;
    return toLifecycle(rows[0]);
  });
}
