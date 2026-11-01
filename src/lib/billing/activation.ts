// Plan caps on how many automations can be active at once.

import { withTenant } from '@/lib/db/tenant';
import { requireWithinLimit } from './entitlements';

// shortcut: callers write in a separate transaction, so two simultaneous activations can pass one over the cap; move the write under requireRoomFor if that matters.
/** Throws PlanLimitError when activating one more automation would exceed the plan. `excludeId` is the one being edited. */
export async function requireActiveAutomationRoom(accountId: string, excludeId?: string): Promise<void> {
  await withTenant({ accountId }, async (tx) => {
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM automations
      WHERE account_id=${accountId}::uuid AND is_active AND id IS DISTINCT FROM ${excludeId ?? null}::uuid`;
    await requireWithinLimit(tx, accountId, 'active_automations', n + 1);
  });
}
