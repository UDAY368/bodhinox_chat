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

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { allSteps, findAutomationCycles, type LoopCandidate } from './validate';

type StepRow = { automation_id: string; step_type: string; step_config: Record<string, unknown> };

/**
 * Sets the automation active when it closes no tag_added loop with the
 * workspace's other active automations, else leaves (or turns) it off and
 * returns the loop as automation names. The caller's tenant (app role, live
 * session) scopes every statement.
 */
export async function activateWithLoopLock(
  tenant: TenantContext,
  accountId: string,
  automationId: string,
  candidate: LoopCandidate,
): Promise<string[] | null> {
  return withTenant(tenant, async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automations-publish:${accountId}`}, 0))`);
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
