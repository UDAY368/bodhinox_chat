// Stage 5 (5E): a member's favourite conversations (the Favourites inbox
// folder). Personal: the own_read/own_write RLS policies scope
// conversation_favourites to (account_id, user_id = app_user_id()), and the
// explicit user_id filters below repeat that. Only conversations the member may
// see (agent visibility, inbox-scope.ts) can be marked or are listed.
import { Prisma } from '@prisma/client';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { conversationVisibleSql } from './inbox-scope';
import { assertConversationVisible, LabelError } from './labels';

type Member = TenantContext & { userId: string };

function member(ctx: TenantContext): Member {
  if (!ctx.userId) throw new Error('A member identity is required');
  return ctx as Member;
}

/** The ids of the member's favourite conversations they may still see. */
export async function listFavourites(ctx: TenantContext): Promise<string[]> {
  const me = member(ctx);
  const rows = await withTenant(me, (tx) => tx.$queryRaw<{ conversation_id: string }[]>(Prisma.sql`
    SELECT f.conversation_id::text AS conversation_id FROM conversation_favourites f
    JOIN conversations c ON c.account_id = f.account_id AND c.id = f.conversation_id
    WHERE f.account_id=${me.accountId}::uuid AND f.user_id=${me.userId}::uuid
      AND ${Prisma.raw(conversationVisibleSql('c'))}
    ORDER BY f.created_at DESC, f.conversation_id`));
  return rows.map((row) => row.conversation_id);
}

/** Validates `{ conversation_id, favourite }`. */
export function parseFavouriteInput(body: unknown): { conversationId: string; favourite: boolean } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof input.conversation_id !== 'string' || typeof input.favourite !== 'boolean') throw new LabelError('invalid_body', 400);
  return { conversationId: input.conversation_id, favourite: input.favourite };
}

/** Marks or unmarks a favourite; idempotent. A conversation the member may not see is 404. */
export async function setFavourite(ctx: TenantContext, conversationId: string, favourite: boolean): Promise<void> {
  const me = member(ctx);
  await withTenant(me, async (tx) => {
    await assertConversationVisible(tx, me.accountId, conversationId);
    if (favourite)
      await tx.$executeRaw`INSERT INTO conversation_favourites(account_id,user_id,conversation_id)
        VALUES(${me.accountId}::uuid,${me.userId}::uuid,${conversationId}::uuid) ON CONFLICT DO NOTHING`;
    else
      await tx.$executeRaw`DELETE FROM conversation_favourites WHERE account_id=${me.accountId}::uuid
        AND user_id=${me.userId}::uuid AND conversation_id=${conversationId}::uuid`;
  });
}
