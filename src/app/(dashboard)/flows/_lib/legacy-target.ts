// The server half of the old /flows and /flows/[id] redirects (Stage 1): the
// caller's live session, then the workspace's channels and the flow's
// channel_scope read under withTenant (RLS: another workspace's flow id reads
// as not found). Nothing about the flow but its channel leaves this module.
import { Prisma } from '@prisma/client';
import { resolveSession } from '@/lib/auth/session';
import { getWorkspaceChannels } from '@/lib/channels/workspace';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import type { FlowChannelScope } from '@/lib/flows/types';
import { legacyFlowsPath } from './legacy-path';

const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The flow's scope inside the tenant transaction; null when it is not this workspace's. */
export async function readFlowScope(tx: TenantTransaction, accountId: string, flowId: string): Promise<FlowChannelScope | null> {
  if (!FLOW_ID.test(flowId)) return null;
  const rows = await tx.$queryRaw<{ channel_scope: FlowChannelScope }[]>(Prisma.sql`
    SELECT channel_scope FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid`);
  return rows[0]?.channel_scope ?? null;
}

/**
 * The redirect target for the signed-in caller, or null when it cannot be
 * worked out on the server (no live access cookie, e.g. one that needs a
 * refresh, or a failed read): the page then redirects on the client.
 */
export async function legacyFlowsTarget(flowId?: string): Promise<string | null> {
  try {
    const session = await resolveSession();
    if (!session) return null;
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    return await withTenant(tenant, async (tx) => {
      const { enabled } = await getWorkspaceChannels(tx, session.accountId);
      const scope = flowId ? await readFlowScope(tx, session.accountId, flowId) : null;
      return legacyFlowsPath(enabled, flowId, scope);
    });
  } catch (err) {
    console.warn('[flows] legacy redirect fell back to the client', err instanceof Error ? err.name : 'unknown');
    return null;
  }
}
