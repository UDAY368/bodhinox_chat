// "Create another workspace" (Phase 14). A signed-in user with a verified email
// (every live session has one) creates a workspace they own: the account, the
// owner membership and its initial plan (NEW_WORKSPACE_PLAN, or the lowest plan when unset), in one
// identity-role transaction with the same SQL as signup's personal workspace.
// The caller's session then switches to it (switchTenant). Capped per owner so a
// script cannot mint workspaces without limit; the route also rate limits.

import { randomUUID } from 'node:crypto';

import { getAuthPrisma } from '@/lib/db/prisma';
import type { AuthContext } from '@/lib/auth/session';
import { assignInitialPlan } from '@/lib/billing/new-workspace-plan';
import { AccountActionError } from './deletion';

/** Workspaces one person may own at a time. */
export const MAX_OWNED_WORKSPACES = 20;
export const WORKSPACE_NAME_MAX = 100;

/** A trimmed, single-line workspace name, or null when unusable. */
export function normalizeWorkspaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= WORKSPACE_NAME_MAX ? name : null;
}

export async function createWorkspace(context: AuthContext, rawName: unknown): Promise<{ accountId: string; name: string }> {
  const name = normalizeWorkspaceName(rawName);
  if (!name) throw new AccountActionError('invalid_name', 400);
  return getAuthPrisma().$transaction(async (tx) => {
    // Serialises this user's creations so the cap holds under concurrent requests.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`create-workspace:${context.userId}`}, 0))`;
    const users = await tx.$queryRaw<{ full_name: string; email: string }[]>`
      SELECT full_name, email FROM auth_users WHERE id=${context.userId}::uuid AND disabled_at IS NULL AND deleted_at IS NULL
        AND email_verified_at IS NOT NULL`;
    const user = users[0];
    if (!user) throw new AccountActionError('email_unverified', 403);
    const owned = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM account_memberships WHERE user_id=${context.userId}::uuid AND role='owner'`;
    if ((owned[0]?.n ?? 0) >= MAX_OWNED_WORKSPACES) throw new AccountActionError('workspace_limit', 409);
    const accountId = randomUUID();
    await tx.$executeRaw`SELECT set_config('app.user_id',${context.userId},true),set_config('app.account_id',${accountId},true),set_config('app.account_role','owner',true)`;
    await tx.$executeRaw`INSERT INTO accounts(id,name,owner_user_id) VALUES(${accountId}::uuid,${name},${context.userId}::uuid)`;
    await tx.$executeRaw`INSERT INTO account_memberships(id,account_id,user_id,role) VALUES(${randomUUID()}::uuid,${accountId}::uuid,${context.userId}::uuid,'owner')`;
    await tx.$executeRaw`INSERT INTO profiles(id,user_id,full_name,email,account_id,account_role) VALUES(${randomUUID()}::uuid,${context.userId}::uuid,${user.full_name},${user.email},${accountId}::uuid,'owner')
      ON CONFLICT(user_id) DO NOTHING`;
    // NEW_WORKSPACE_PLAN, or the lowest plan when unset (never the unrestricted default).
    await assignInitialPlan(tx, accountId);
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${accountId}::uuid,${context.userId}::uuid,'workspace.created',${accountId},${JSON.stringify({ from_account: context.accountId })}::jsonb)`;
    return { accountId, name };
  });
}
