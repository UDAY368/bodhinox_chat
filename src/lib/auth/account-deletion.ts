// "Delete my account" (Phase 14), identity role.
//
// Re-authentication: the current password (or, for an account created through
// Google that never set one, a Google sign-in on this session in the last few
// minutes), plus the authenticator or a recovery code when the user has MFA.
//
// Refused while the user owns a workspace that has other members (transfer
// ownership first) or a paid provider subscription that is not already
// cancelling (request workspace deletion first, which cancels it). Each
// sole-member workspace the user owns gets a deletion request instead
// ('closing', 30-day grace, nothing purged). Then: memberships of other
// workspaces end, every session and refresh token is revoked, the MFA factor
// and Google links are removed, the user's API keys are revoked, and the
// auth_users row is anonymised and disabled. user_id stays the historical
// audit identity everywhere; nothing tenant-side is deleted.

import { getAuthPrisma } from '@/lib/db/prisma';
import { AuthError } from './errors';
import { checkMfa, confirmIdentity } from './mfa';
import type { AuthContext } from './session';

export const DELETED_EMAIL_DOMAIN = 'invalid';
/** The address an anonymised identity keeps (unique, undeliverable). */
export const deletedEmail = (userId: string): string => `deleted+${userId}@${DELETED_EMAIL_DOMAIN}`;

export interface AccountDeletionResult {
  closedWorkspaces: number;
  leftWorkspaces: number;
  revokedApiKeys: number;
}

const BLOCKS: Record<string, string> = {
  owns_shared_workspace: 'Transfer ownership of the workspaces you share with others, or remove their members, before deleting your account',
  active_subscription: 'Cancel the paid plan of your workspace (delete the workspace) before deleting your account',
};

export async function deleteMyAccount(context: AuthContext, input: { password?: string; mfaCode?: string }): Promise<AccountDeletionResult> {
  return getAuthPrisma().$transaction(async (tx) => {
    const users = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM auth_users WHERE id=${context.userId}::uuid AND deleted_at IS NULL AND disabled_at IS NULL FOR UPDATE`;
    if (!users[0]) throw new AuthError('Account is unavailable', 401, 'unauthorized');
    await confirmIdentity(tx, context, input.password);
    // MFA step-up for users with a factor (checkMfa refuses a missing or reused code).
    await checkMfa(tx, context.userId, input.mfaCode);
    const [prepared] = await tx.$queryRaw<{ blocked: boolean; block_reason: string | null; closed_workspaces: number; revoked_keys: number }[]>`
      SELECT * FROM auth_prepare_account_deletion(${context.userId}::uuid)`;
    if (!prepared || prepared.blocked) {
      const reason = prepared?.block_reason ?? 'owns_shared_workspace';
      throw new AuthError(BLOCKS[reason] ?? BLOCKS.owns_shared_workspace, 409, reason);
    }
    const left = await tx.$queryRaw<{ account_id: string }[]>`
      DELETE FROM account_memberships WHERE user_id=${context.userId}::uuid AND role<>'owner' RETURNING account_id`;
    for (const { account_id } of left)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${account_id}::uuid,${context.userId}::uuid,'member.account_deleted',${context.userId},'{}'::jsonb)`;
    await tx.$executeRaw`UPDATE auth_refresh_tokens SET consumed_at=COALESCE(consumed_at,NOW())
      WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id=${context.userId}::uuid)`;
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`UPDATE auth_verifications SET consumed_at=COALESCE(consumed_at,NOW()) WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`DELETE FROM auth_mfa_factors WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`DELETE FROM auth_identities WHERE user_id=${context.userId}::uuid`;
    const anonymous = deletedEmail(context.userId);
    await tx.$executeRaw`UPDATE profiles SET full_name='',email=${anonymous},updated_at=NOW() WHERE user_id=${context.userId}::uuid`;
    await tx.$executeRaw`UPDATE auth_users SET email=${anonymous},full_name='',password_hash='',password_set=false,
      disabled_at=COALESCE(disabled_at,NOW()),deleted_at=NOW() WHERE id=${context.userId}::uuid`;
    return { closedWorkspaces: Number(prepared.closed_workspaces), leftWorkspaces: left.length, revokedApiKeys: Number(prepared.revoked_keys) };
  });
}
