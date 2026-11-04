// Usage limits checked BEFORE an assistant provider call.
//
// Runs on the worker client inside the workspace's tenant scope (one code
// path for routes and jobs, like requireAiMessageRoom). Refuses when the
// tokens counted this IST month plus this call's worst case (maxTokensFor:
// ASCII at characters / 4, every other character at one token, plus the
// output cap) would exceed the
// plan's ai_tokens_monthly or the workspace's monthly_token_cap. 'suggest'
// produces customer-message text, so it also needs room in the plan's monthly
// AI messages. Counters cannot be decremented, so nothing is reserved: under
// concurrency the overshoot is bounded by (concurrent calls x per-feature max).

import type { PrismaClient } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { PlanLimitError, requireWithinLimit } from '@/lib/billing/entitlements';
import { aiTokensUsed, requireAiMessageRoom } from '@/lib/billing/limits';
import type { AiAssistFeature } from './types';

/** The workspace's own cap was reached (402, like a plan limit). */
export class AiWorkspaceCapError extends PlanLimitError {
  constructor() {
    super("This workspace's monthly AI token cap is reached. An admin can raise it in AI settings.");
  }
}

/** Throws PlanLimitError (or AiWorkspaceCapError) when the call would exceed a monthly AI limit. */
export async function requireAiBudget(
  accountId: string,
  feature: AiAssistFeature,
  maxTokens: number,
  db: PrismaClient = getWorkerPrisma(),
): Promise<void> {
  const wanted = Math.max(1, Math.ceil(maxTokens));
  await withTenant({ accountId }, async (tx) => {
    const used = await aiTokensUsed(tx, accountId);
    await requireWithinLimit(tx, accountId, 'ai_tokens_monthly', used + wanted);
    const [settings] = await tx.$queryRaw<{ cap: bigint | null }[]>`SELECT monthly_token_cap AS cap
      FROM ai_workspace_settings WHERE account_id=${accountId}::uuid`;
    if (settings?.cap !== null && settings?.cap !== undefined && used + wanted > Number(settings.cap)) throw new AiWorkspaceCapError();
  }, db);
  if (feature === 'suggest') await requireAiMessageRoom(accountId, db);
}
