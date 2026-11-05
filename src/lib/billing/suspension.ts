// A suspended workspace can still sign in, read its data and pay, but sends
// nothing on its own: campaigns, flows, automations and AI replies are refused
// here, at the shared send gates. Manual replies by agents stay available.
//
// Three independent reasons stop automatic sending, and clearing one never
// clears another:
//   - billing: the subscription is 'suspended' (grace ended without payment);
//   - admin:   a platform admin suspended the workspace (account_lifecycle
//              'admin_suspended', reason recorded, both audit trails);
//   - closing: the owner asked to delete the workspace (account_lifecycle
//              'closing', until the owner cancels).
// Inbound messages, opt-outs, payment webhooks and reconciliation never call
// these gates, so they keep working in every state.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { PlanLimitError } from './entitlements';

export type SuspensionReason = 'billing' | 'admin' | 'closing';

const MESSAGE_KEY: Record<SuspensionReason, string> = { billing: 'suspended', admin: 'adminSuspended', closing: 'closing' };
const CODE: Record<SuspensionReason, string> = {
  billing: 'plan_limit',
  admin: 'workspace_admin_suspended',
  closing: 'workspace_closing',
};

/**
 * HTTP 402. The billing reason keeps today's message and 'plan_limit' code (pay to resume); an admin
 * suspension or a closing workspace has its own code and message, so nobody is told to pay for it.
 */
export class WorkspaceSuspendedError extends PlanLimitError {
  constructor(readonly reason: SuspensionReason = 'billing') {
    super(getT('Validation.billing')(MESSAGE_KEY[reason]));
    this.name = 'WorkspaceSuspendedError';
    if (reason !== 'billing') (this as { code: string }).code = CODE[reason];
  }
}

/**
 * Why automatic sending is stopped for the workspace, or null. An admin suspension wins over a
 * closing workspace, which wins over billing. One round trip on two primary-key lookups.
 */
export async function suspensionReason(tx: TenantTransaction, accountId: string): Promise<SuspensionReason | null> {
  const rows = await tx.$queryRaw<{ lifecycle: string | null; billing: boolean }[]>`
    SELECT (SELECT l.status FROM account_lifecycle l WHERE l.account_id=${accountId}::uuid) AS lifecycle,
      EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id=${accountId}::uuid AND s.status='suspended') AS billing`;
  const row = rows[0];
  if (row?.lifecycle === 'admin_suspended') return 'admin';
  if (row?.lifecycle === 'closing') return 'closing';
  return row?.billing === true ? 'billing' : null;
}

/** Whether automatic sending is stopped (billing, admin or closing), in the caller's tenant transaction. */
export async function isSuspended(tx: TenantTransaction, accountId: string): Promise<boolean> {
  return (await suspensionReason(tx, accountId)) !== null;
}

/** Throws WorkspaceSuspendedError (HTTP 402) inside an existing tenant transaction. */
export async function requireSendingAllowed(tx: TenantTransaction, accountId: string): Promise<void> {
  const reason = await suspensionReason(tx, accountId);
  if (reason) throw new WorkspaceSuspendedError(reason);
}

/** For engine send paths without a transaction at hand (worker role, tenant scope). */
export async function assertOutboundAllowed(accountId: string): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => requireSendingAllowed(tx, accountId), getWorkerPrisma());
}
