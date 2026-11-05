// Turning an automation on, serialised per account (Phase 12, design §4.1).
//
// The save-time loop check in publish-checks reads the other active
// automations outside any lock, so two members activating A (X -> Y) and
// B (Y -> X) at the same moment could each pass it. Routes therefore write a
// newly activated automation as inactive, then flip it on here: under the
// same per-account advisory lock for every activation, the tag_added loop
// check is run again on the active set read in this transaction, and the
// automation is set active only when no loop closes. Mirrors the flow
// publish lock (flows/versions.ts lockAccountPublishing).
//
// The plan's active_automations cap is checked here too, in the transaction
// that sets is_active, so two simultaneous activations cannot both take the
// last slot. An automation that is already active is never refused or turned
// off by the cap (editing it re-runs this function).

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { requireActiveAutomationRoom } from '@/lib/billing/limits';
import { allSteps, findAutomationCycles, type LoopCandidate } from './validate';

type StepRow = { automation_id: string; step_type: string; step_config: Record<string, unknown> };

/**
 * Sets the automation active when it closes no tag_added loop with the
 * workspace's other active automations, else leaves (or turns) it off and
 * returns the loop as automation names. Throws PlanLimitError (402), changing
 * nothing, when turning it on would exceed the plan's active automations. The
 * caller's tenant (app role, live session) scopes every statement.
 */
export async function activateWithLoopLock(
  tenant: TenantContext,
  accountId: string,
  automationId: string,
  candidate: LoopCandidate,
): Promise<string[] | null> {
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automations-publish:${accountId}`}, 0))`);
    const [current] = await tx.$queryRaw<{ is_active: boolean }[]>(Prisma.sql`SELECT is_active FROM automations
      WHERE account_id=${accountId}::uuid AND id=${automationId}::uuid`);
    if (!current?.is_active) await requireActiveAutomationRoom(tx, accountId, automationId);
    let chain: string[] | null = null;
    if (allSteps(candidate.steps).some((s) => s.step_type === 'add_tag')) {
      const others = await tx.$queryRaw<{ id: string; name: string; trigger_type: string; trigger_config: unknown }[]>(Prisma.sql`
        SELECT id::text, name, trigger_type, trigger_config FROM automations
        WHERE account_id=${accountId}::uuid AND is_active AND id<>${automationId}::uuid`);
      const steps = others.length
        ? await tx.$queryRaw<StepRow[]>(Prisma.sql`SELECT automation_id::text, step_type, step_config FROM automation_steps
            WHERE account_id=${accountId}::uuid AND step_type='add_tag' AND automation_id = ANY(${others.map((o) => o.id)}::uuid[])`)
        : [];
      chain = findAutomationCycles({ ...candidate, id: automationId },
        others.map((o) => ({ ...o, steps: steps.filter((s) => s.automation_id === o.id) })));
    }
    await tx.$executeRaw(Prisma.sql`UPDATE automations SET is_active=${chain === null}
      WHERE account_id=${accountId}::uuid AND id=${automationId}::uuid`);
    return chain;
  });
}
