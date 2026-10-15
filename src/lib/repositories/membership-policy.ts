import { ContractError } from '@/lib/data/contracts';
import type { AccountRole } from '@/lib/auth/roles';
export function authorizeMemberChange(
  actor: AccountRole,
  target: AccountRole,
  operation: 'set' | 'remove' | 'transfer',
  newRole?: string
): void {
  if (operation === 'transfer') {
    if (actor !== 'owner')
      throw new ContractError(
        'Only an owner can transfer ownership',
        '42501',
        403
      );
    return;
  }
  if (!['owner', 'admin'].includes(actor))
    throw new ContractError('Admin permission required', '42501', 403);
  if (target === 'owner')
    throw new ContractError('The owner cannot be removed or demoted', '22023');
  if (
    operation === 'set' &&
    !['admin', 'agent', 'viewer'].includes(newRole ?? '')
  )
    throw new ContractError('Invalid member role', '22023');
}
export function validateInviteHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value))
    throw new ContractError('Invalid invitation token', '22023');
}
