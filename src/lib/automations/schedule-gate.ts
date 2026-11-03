// Plan gate for time-based automations that message contacts: they are
// recurring scheduled campaigns, so they need the campaign_scheduling feature.

import { withTenant } from '@/lib/db/tenant';
import { requireFeature } from '@/lib/billing/entitlements';
import { stepsSendMessages, type ScheduledStep } from './scheduled-contract';

/** Throws PlanLimitError when an active time_based automation with a send step is not in the plan. */
export async function requireScheduledSendingAllowed(
  accountId: string,
  triggerType: string,
  steps: readonly ScheduledStep[]
): Promise<void> {
  if (triggerType !== 'time_based' || !stepsSendMessages(steps)) return;
  await withTenant({ accountId }, (tx) =>
    requireFeature(tx, accountId, 'campaign_scheduling')
  );
}
