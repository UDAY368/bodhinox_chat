// The ad or post that started a conversation, for the inbox "Started from ad"
// badge. Reads app-visible columns only: the click id (ctwa_clid) is not
// granted to the app role and is never selected here.
import type { TenantContext } from '@/lib/db/tenant';
import { withTenant } from '@/lib/db/tenant';
import type { AdReferralSourceType } from './referrals';

export interface ConversationAdReferral {
  headline: string | null;
  sourceUrl: string | null;
  sourceType: AdReferralSourceType;
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConversationNotFoundError extends Error {}

/**
 * The conversation's first stored referral, or null when it did not start from
 * an ad. Throws ConversationNotFoundError when the conversation is not visible
 * to the caller (another workspace, or hidden by conversation RLS).
 */
export async function conversationAdReferral(ctx: TenantContext, conversationId: string): Promise<ConversationAdReferral | null> {
  if (!UUID.test(conversationId)) throw new ConversationNotFoundError();
  return withTenant(ctx, async (tx) => {
    const visible = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM conversations WHERE account_id=${ctx.accountId}::uuid AND id=${conversationId}::uuid`;
    if (!visible[0]) throw new ConversationNotFoundError();
    const rows = await tx.$queryRaw<{ headline: string | null; source_url: string | null; source_type: AdReferralSourceType; created_at: Date }[]>`
      SELECT headline, source_url, source_type, created_at FROM ad_referrals
      WHERE account_id=${ctx.accountId}::uuid AND conversation_id=${conversationId}::uuid
      ORDER BY created_at, id
      LIMIT 1`;
    const row = rows[0];
    return row ? { headline: row.headline, sourceUrl: row.source_url, sourceType: row.source_type, createdAt: row.created_at.toISOString() } : null;
  });
}
