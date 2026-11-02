// A suspended workspace (grace ended without payment) can still sign in, read
// its data and pay, but sends nothing on its own: campaigns, flows,
// automations and AI replies are refused here, at the shared send gates.
// Manual replies by agents stay available.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { PlanLimitError } from './entitlements';

export class WorkspaceSuspendedError extends PlanLimitError {
  constructor() {
    super(getT('Validation.billing')('suspended'));
    this.name = 'WorkspaceSuspendedError';
  }
}

/** Whether the workspace's subscription is suspended, in the caller's tenant transaction. */
export async function isSuspended(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ suspended: boolean }[]>`
    SELECT status = 'suspended' AS suspended FROM account_subscriptions WHERE account_id=${accountId}::uuid`;
  return rows[0]?.suspended === true;
}

/** Throws WorkspaceSuspendedError (HTTP 402) inside an existing tenant transaction. */
export async function requireSendingAllowed(tx: TenantTransaction, accountId: string): Promise<void> {
  if (await isSuspended(tx, accountId)) throw new WorkspaceSuspendedError();
}

/** For engine send paths without a transaction at hand (worker role, tenant scope). */
export async function assertOutboundAllowed(accountId: string): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => requireSendingAllowed(tx, accountId), getWorkerPrisma());
}
