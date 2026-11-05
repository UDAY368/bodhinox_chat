import { getAuthPrisma } from '@/lib/db/prisma';
import { ContractError } from '@/lib/data/contracts';
import type { AccountRole } from '@/lib/auth/roles';
import type {
  QueryResult,
  Row,
  TenantContext,
  LegacyData,
} from '@/lib/data/types';
import { authorizeMemberChange, validateInviteHash } from './membership-policy';

export async function peekInvitation(tokenHash: string): Promise<Row> {
  validateInviteHash(tokenHash);
  const found = await getAuthPrisma().$queryRawUnsafe<Row[]>(
    'SELECT i.role,i.expires_at,i.accepted_at,a.name AS account_name,p.full_name AS inviter_name FROM account_invitations i JOIN accounts a ON a.id=i.account_id LEFT JOIN profiles p ON p.user_id=i.created_by_user_id WHERE i.token_hash=$1 LIMIT 1',
    tokenHash
  );
  const invite = found[0];
  if (!invite) return { ok: false, reason: 'not_found' };
  if (invite.accepted_at) return { ok: false, reason: 'used' };
  if (new Date(invite.expires_at).getTime() <= Date.now())
    return { ok: false, reason: 'expired' };
  return {
    ok: true,
    account_name: invite.account_name,
    inviter_name: invite.inviter_name,
    role: invite.role,
    expires_at: invite.expires_at,
  };
}
/**
 * leave_account: a non-owner leaves the current workspace (Phase 14). The owner
 * must transfer ownership first; a user with no other workspace is refused (they
 * delete their account instead). In one identity-role transaction: the
 * membership is deleted, the user's other sessions in that workspace are
 * revoked, the current session moves to the user's oldest remaining workspace,
 * and both workspaces get an audit row. Returns the workspace the session moved to.
 */
export async function leaveAccount(context: {
  userId: string;
  accountId: string;
  sessionId: string;
}): Promise<{ nextAccountId: string }> {
  return getAuthPrisma().$transaction(async (tx) => {
    const memberships = await tx.$queryRawUnsafe<Row[]>(
      'SELECT role FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid FOR UPDATE',
      context.userId,
      context.accountId
    );
    const membership = memberships[0];
    if (!membership) throw new ContractError('Membership required', '42501', 403);
    if (membership.role === 'owner')
      throw new ContractError('Transfer ownership before leaving this workspace', 'owner_must_transfer', 409);
    const others = await tx.$queryRawUnsafe<Row[]>(
      'SELECT account_id FROM account_memberships WHERE user_id=$1::uuid AND account_id<>$2::uuid ORDER BY created_at, id LIMIT 1',
      context.userId,
      context.accountId
    );
    const next = others[0]?.account_id as string | undefined;
    if (!next)
      throw new ContractError('This is your only workspace; delete your account instead', 'last_workspace', 409);
    await tx.$executeRawUnsafe(
      'DELETE FROM account_memberships WHERE account_id=$1::uuid AND user_id=$2::uuid',
      context.accountId,
      context.userId
    );
    // Old JWT sessions must not retain authority in the workspace that was left.
    await tx.$executeRawUnsafe(
      'UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1::uuid AND user_id=$2::uuid AND id<>$3::uuid AND revoked_at IS NULL',
      context.accountId,
      context.userId,
      context.sessionId
    );
    const moved = await tx.$executeRawUnsafe(
      'UPDATE auth_sessions SET account_id=$1::uuid WHERE id=$2::uuid AND user_id=$3::uuid AND account_id=$4::uuid AND revoked_at IS NULL',
      next,
      context.sessionId,
      context.userId,
      context.accountId
    );
    if (moved !== 1) throw new ContractError('Authentication required', '42501', 401);
    await tx.$executeRawUnsafe(
      'INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb)',
      context.accountId,
      context.userId,
      'membership.leave',
      context.userId,
      JSON.stringify({ oldRole: membership.role })
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb)',
      next,
      context.userId,
      'auth.tenant_switch',
      context.sessionId,
      JSON.stringify({ reason: 'left_workspace' })
    );
    return { nextAccountId: next };
  });
}
export async function executeMembershipRpc(
  name: string,
  args: Row,
  context: TenantContext
): Promise<QueryResult<LegacyData>> {
  if (name === 'peek_invitation')
    return { data: await peekInvitation(args.p_token_hash), error: null };
  if (!context.userId)
    throw new ContractError('Authenticated identity required', '42501', 401);
  const data = await getAuthPrisma().$transaction(async (tx) => {
    if (name === 'redeem_invitation') {
      validateInviteHash(args.p_token_hash);
      const invites = await tx.$queryRawUnsafe<Row[]>(
        'SELECT * FROM account_invitations WHERE token_hash=$1 FOR UPDATE',
        args.p_token_hash
      );
      const invite = invites[0];
      if (
        !invite ||
        invite.accepted_at ||
        new Date(invite.expires_at).getTime() <= Date.now()
      )
        throw new ContractError('Invitation is unavailable', '22023');
      if (!['admin', 'agent', 'viewer'].includes(invite.role))
        throw new ContractError('Invalid invitation role', '22023');
      // A workspace whose deletion was requested takes no new members.
      const closing = await tx.$queryRawUnsafe<{ closing: boolean }[]>(
        'SELECT auth_workspace_closing($1::uuid) AS closing',
        invite.account_id
      );
      if (closing[0]?.closing)
        throw new ContractError('Invitation is unavailable', '22023');
      const memberships = await tx.$queryRawUnsafe<Row[]>(
        'SELECT role FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid FOR UPDATE',
        context.userId,
        invite.account_id
      );
      if (memberships.length)
        throw new ContractError(
          'Already a member of this organization',
          '23505',
          409
        );
      await tx.$executeRawUnsafe(
        'INSERT INTO account_memberships(account_id,user_id,role) VALUES($1::uuid,$2::uuid,$3)',
        invite.account_id,
        context.userId,
        invite.role
      );
      await tx.$executeRawUnsafe(
        'UPDATE account_invitations SET accepted_at=NOW(),accepted_by_user_id=$1::uuid WHERE id=$2::uuid',
        context.userId,
        invite.id
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb)',
        invite.account_id,
        context.userId,
        'invitation.redeemed',
        invite.id,
        JSON.stringify({ role: invite.role })
      );
      return invite.account_id;
    }
    const account = await tx.$queryRawUnsafe<Row[]>(
      'SELECT id,owner_user_id FROM accounts WHERE id=$1::uuid FOR UPDATE',
      context.accountId
    );
    if (!account.length)
      throw new ContractError('Organization not found', '22023');
    const actors = await tx.$queryRawUnsafe<Row[]>(
      'SELECT role FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid FOR UPDATE',
      context.userId,
      context.accountId
    );
    const actor = actors[0];
    if (!actor) throw new ContractError('Membership required', '42501', 403);
    const targetId =
      name === 'transfer_account_ownership'
        ? args.p_new_owner_user_id
        : args.p_user_id;
    if (
      typeof targetId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        targetId
      )
    )
      throw new ContractError('Invalid member ID', '22023');
    const targets = await tx.$queryRawUnsafe<Row[]>(
      'SELECT role FROM account_memberships WHERE user_id=$1::uuid AND account_id=$2::uuid FOR UPDATE',
      targetId,
      context.accountId
    );
    const target = targets[0];
    if (!target) throw new ContractError('Member not found', '22023');
    const operation =
      name === 'transfer_account_ownership'
        ? 'transfer'
        : name === 'remove_account_member'
          ? 'remove'
          : 'set';
    authorizeMemberChange(
      actor.role as AccountRole,
      target.role as AccountRole,
      operation,
      args.p_new_role
    );
    if (operation === 'transfer') {
      if (targetId === context.userId)
        throw new ContractError('Choose another owner', '22023');
      await tx.$executeRawUnsafe(
        "UPDATE account_memberships SET role='admin' WHERE account_id=$1::uuid AND user_id=$2::uuid",
        context.accountId,
        context.userId
      );
      await tx.$executeRawUnsafe(
        "UPDATE account_memberships SET role='owner' WHERE account_id=$1::uuid AND user_id=$2::uuid",
        context.accountId,
        targetId
      );
      await tx.$executeRawUnsafe(
        'UPDATE accounts SET owner_user_id=$1::uuid WHERE id=$2::uuid',
        targetId,
        context.accountId
      );
    } else if (operation === 'remove')
      await tx.$executeRawUnsafe(
        'DELETE FROM account_memberships WHERE account_id=$1::uuid AND user_id=$2::uuid',
        context.accountId,
        targetId
      );
    else
      await tx.$executeRawUnsafe(
        'UPDATE account_memberships SET role=$1 WHERE account_id=$2::uuid AND user_id=$3::uuid',
        args.p_new_role,
        context.accountId,
        targetId
      );
    // Old JWT sessions must not retain authority after a role or membership change.
    await tx.$executeRawUnsafe(
      'UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1::uuid AND user_id=$2::uuid AND revoked_at IS NULL',
      context.accountId,
      targetId
    );
    if (operation === 'transfer')
      await tx.$executeRawUnsafe(
        'UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1::uuid AND user_id=$2::uuid AND revoked_at IS NULL',
        context.accountId,
        context.userId
      );
    await tx.$executeRawUnsafe(
      'INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata) VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb)',
      context.accountId,
      context.userId,
      `membership.${operation}`,
      targetId,
      JSON.stringify({
        oldRole: target.role,
        newRole: operation === 'transfer' ? 'owner' : (args.p_new_role ?? null),
      })
    );
    return null;
  });
  return { data, error: null };
}
