// Server side of the channel inboxes (Stage 1): the redirect an inbox page
// URL needs, read under the signed-in member's tenant. Used only by the
// /inbox, /whatsapp/inbox and /instagram/inbox server pages.
//
// Best effort: without a resolvable session (an expired access cookie the
// browser refreshes later) or on any error the page renders as asked, and
// the inbox client still lists only what its tenant can read.
import { Prisma } from '@prisma/client';
import { resolveSession } from '@/lib/auth/session';
import { getWorkspaceChannels } from '@/lib/channels/workspace';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { isUuid } from '@/lib/inbox/saved-filters';
import type { Channel } from '@/types';
import { channelOfConversation, inboxRedirectTarget, toSearchParams, type InboxScope } from './inbox-scope';

/**
 * The channel of one of this workspace's conversations, or null when the id
 * is not a conversation of `accountId` (RLS and the account filter both apply).
 */
export async function conversationChannelById(tx: TenantTransaction, accountId: string, conversationId: string): Promise<Channel | null> {
  if (!isUuid(conversationId)) return null;
  const rows = await tx.$queryRaw<{ channel: string | null }[]>(Prisma.sql`
    SELECT channel FROM conversations WHERE id=${conversationId}::uuid AND account_id=${accountId}::uuid`);
  return rows[0] ? channelOfConversation(rows[0]) : null;
}

/** The redirect for an inbox page request, or null to render the page. */
export async function resolveInboxRedirect(scope: InboxScope,
  params: Record<string, string | string[] | undefined>): Promise<string | null> {
  try {
    const search = toSearchParams(params);
    const conversationId = search.get('c');
    // A channel inbox redirects only a ?c= of another channel's conversation.
    // Selecting a conversation rewrites ?c= and re-runs this page, so that
    // common case reads one row and skips the channel state.
    if (scope !== 'all' && !conversationId) return null;
    const session = await resolveSession();
    if (!session) return null;
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    return await withTenant(tenant, async (tx) => {
      const conversationChannel = conversationId ? await conversationChannelById(tx, session.accountId, conversationId) : null;
      if (scope !== 'all' && (!conversationChannel || conversationChannel === scope)) return null;
      const { enabled } = await getWorkspaceChannels(tx, session.accountId);
      return inboxRedirectTarget({ scope, enabled, conversationChannel, search });
    });
  } catch {
    // The page still renders; its data loads through the tenant-checked data API.
    return null;
  }
}
