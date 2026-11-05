// The plan a brand-new workspace starts on (Phase 14).
//
// NEW_WORKSPACE_PLAN unset (the default): nothing happens, and a new workspace
// has no subscription row, so it resolves to 'enterprise' exactly as before.
// Set to a plan id: every path that creates a workspace (email signup, Google
// signup, "create another workspace") also gives it that plan, status
// 'active', no provider ids, pinned to the plan's current version, in the same
// identity-role transaction, through billing_assign_initial_plan. That
// function inserts only when the workspace has no subscription row and was
// created in the last hour, so it can never change an existing workspace.
// Invite joins create no workspace and are never touched. A later checkout
// upgrades the provider-less row like any other.

import type { AuthTransaction } from '@/lib/auth/service';

const PLAN_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** The configured plan id, or null when unset. A malformed value is a configuration error. */
export function newWorkspacePlan(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEW_WORKSPACE_PLAN?.trim();
  if (!raw) return null;
  if (!PLAN_ID.test(raw)) throw new Error('NEW_WORKSPACE_PLAN must be a plan id such as free or basic');
  return raw;
}

/**
 * Gives a workspace created in this transaction its initial plan when NEW_WORKSPACE_PLAN is set.
 * Returns true when a subscription row was created. An unknown plan id fails the transaction, so
 * a misconfigured deployment refuses signups loudly instead of silently handing out 'enterprise'.
 */
export async function assignInitialPlan(tx: AuthTransaction, accountId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const plan = newWorkspacePlan(env);
  if (!plan) return false;
  const rows = await tx.$queryRaw<{ assigned: boolean }[]>`SELECT billing_assign_initial_plan(${accountId}::uuid, ${plan}) AS assigned`;
  return rows[0]?.assigned === true;
}
