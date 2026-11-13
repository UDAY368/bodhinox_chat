// The inbox's "Failed" filter (linked from Analytics > Overview > Needs
// attention): conversations the caller can see whose latest message from the
// team (an agent or the bot) failed to send. Read-only and tenant-scoped; the
// scan is bounded to conversations active in the last 30 days, newest first.

import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { conversationVisible } from './visibility-sql';

export const FAILED_OUTBOUND_LIMIT = 5000;

export async function conversationsWithFailedLastOutbound(ctx: TenantContext): Promise<string[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT c.id::text FROM conversations c
      CROSS JOIN LATERAL (
        SELECT m.status FROM messages m
        WHERE m.account_id = c.account_id AND m.conversation_id = c.id AND m.sender_type IN ('agent','bot')
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) last_out
      WHERE c.account_id = ${ctx.accountId}::uuid AND ${conversationVisible('c')}
        AND c.last_message_at > now() - interval '30 days'
        AND last_out.status = 'failed'
      ORDER BY c.last_message_at DESC NULLS LAST, c.id
      LIMIT ${FAILED_OUTBOUND_LIMIT}`);
    return rows.map((r) => r.id);
  });
}
