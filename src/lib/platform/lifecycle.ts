// Tenant lifecycle as the platform console and the tenant see it.
//
// A platform admin suspends or reactivates a workspace (reason required) and
// may block manual agent replies (abuse). Suspension stops automatic sending
// through the shared send gates (src/lib/billing/suspension.ts); block_manual
// also refuses manual replies at the inbox send route. Neither touches inbound
// messages, opt-outs, payment webhooks or reconciliation. 'closing' belongs to
// the owner's deletion request and is never set here.

import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { platformSetLifecycle } from './db';
import type { PlatformAdmin } from '@/types/platform';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LifecycleChange {
  accountId: string;
  status: 'active' | 'admin_suspended';
  blockManual: boolean;
  reason: string;
}

/** The console's lifecycle body, or null when invalid. Reason 10..1000 characters (the database repeats the check). */
export function parseLifecycleChange(body: unknown): LifecycleChange | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.some((k) => !['accountId', 'status', 'blockManual', 'reason'].includes(k))) return null;
  if (typeof b.accountId !== 'string' || !UUID.test(b.accountId)) return null;
  if (b.status !== 'active' && b.status !== 'admin_suspended') return null;
  if (b.blockManual !== undefined && typeof b.blockManual !== 'boolean') return null;
  if (typeof b.reason !== 'string') return null;
  const reason = b.reason.trim();
  if (reason.length < 10 || reason.length > 1000) return null;
  return { accountId: b.accountId.toLowerCase(), status: b.status, blockManual: b.blockManual === true, reason };
}

/** Applies the change through crm_platform_set_lifecycle (both audit trails, owners and admins notified). */
export async function changeLifecycle(admin: PlatformAdmin, change: LifecycleChange): Promise<void> {
  await platformSetLifecycle({ ...change, adminEmail: admin.email });
}

/** Whether a platform admin blocked manual replies for this workspace, in the caller's tenant transaction. */
export async function manualRepliesBlockedIn(tx: TenantTransaction, accountId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ block_manual: boolean }[]>`
    SELECT block_manual FROM account_lifecycle WHERE account_id=${accountId}::uuid`;
  return rows[0]?.block_manual === true;
}

/** The inbox send route's check: true refuses the manual reply (403 'workspace_manual_blocked'). */
export async function manualRepliesBlocked(tenant: TenantContext): Promise<boolean> {
  return withTenant(tenant, (tx) => manualRepliesBlockedIn(tx, tenant.accountId));
}
