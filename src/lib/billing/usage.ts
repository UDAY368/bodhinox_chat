// Current usage against each plan limit, for the Plan & usage panel and limit checks.

import type { TenantTransaction } from '@/lib/db/tenant';
import type { LimitKey } from './entitlements';

/** Counted the same way the limits are enforced. campaign_recipients is per campaign, so it has no running total. */
export async function currentUsage(tx: TenantTransaction, accountId: string): Promise<Record<Exclude<LimitKey, 'campaign_recipients'>, number>> {
  const [row] = await tx.$queryRaw<{ seats: number; segments: number; lists: number; active_flows: number; active_automations: number }[]>`
    SELECT
      (SELECT count(*)::int FROM account_memberships m WHERE m.account_id=${accountId}::uuid)
        + (SELECT count(*)::int FROM account_invitations i WHERE i.account_id=${accountId}::uuid AND i.accepted_at IS NULL AND i.expires_at > now()) AS seats,
      (SELECT count(*)::int FROM segments s WHERE s.account_id=${accountId}::uuid) AS segments,
      (SELECT count(*)::int FROM contact_lists l WHERE l.account_id=${accountId}::uuid) AS lists,
      (SELECT count(*)::int FROM flows f WHERE f.account_id=${accountId}::uuid
        AND (f.status='active' OR (f.status='draft' AND cardinality(f.test_numbers)>0))) AS active_flows,
      (SELECT count(*)::int FROM automations a WHERE a.account_id=${accountId}::uuid AND a.is_active) AS active_automations`;
  return row;
}
