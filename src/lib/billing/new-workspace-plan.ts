// The plan a brand-new workspace starts on (Phase 14; audit finding 41).
//
// Every path that creates a workspace (email signup, Google signup, "create
// another workspace") gives it an initial plan, status 'active', no provider
// ids, pinned to the plan's current version, in the same identity-role
// transaction, through billing_assign_initial_plan:
//   NEW_WORKSPACE_PLAN set    that plan id (an unknown id fails the signup).
//   NEW_WORKSPACE_PLAN unset  the lowest plan in the catalogue (smallest sort,
//                             'free' in the seeded catalogue), never the
//                             unrestricted 'enterprise' a workspace without a
//                             subscription row resolves to.
// The function inserts only when the workspace has no subscription row and
// was created in the last hour, so it can never change an existing workspace:
// workspaces created before this rule keep exactly the plan they resolve to
// today. Invite joins create no workspace and are never touched. A later
// checkout upgrades the provider-less row like any other.

import type { AuthTransaction } from '@/lib/auth/service';

const PLAN_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** The configured plan id, or null when unset (the lowest plan). A malformed value is a configuration error. */
export function newWorkspacePlan(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEW_WORKSPACE_PLAN?.trim();
  if (!raw) return null;
  if (!PLAN_ID.test(raw)) throw new Error('NEW_WORKSPACE_PLAN must be a plan id such as free or basic');
  return raw;
}

/**
 * Gives a workspace created in this transaction its initial plan: NEW_WORKSPACE_PLAN, or the lowest
 * plan when unset. Returns true when a subscription row was created. An unknown plan id fails the
 * transaction, so a misconfigured deployment refuses signups loudly instead of handing out 'enterprise'.
 */
export async function assignInitialPlan(tx: AuthTransaction, accountId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const plan = newWorkspacePlan(env);
  const rows = await tx.$queryRaw<{ assigned: boolean }[]>`SELECT billing_assign_initial_plan(${accountId}::uuid, ${plan}::text) AS assigned`;
  return rows[0]?.assigned === true;
}
