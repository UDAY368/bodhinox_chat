// Bulk inbox actions (batch 7): assign, resolve, label or mark read the
// conversations ticked in the list, or every conversation matching the list's
// filter (at most MAX_BULK_CONVERSATIONS). The targets are worked out once,
// through the member's visibility, then changed in chunks of BULK_CHUNK, each
// in its own tenant transaction with its own audit row, so one request never
// holds thousands of row locks. Each chunk runs the same set-based action the
// single-conversation routes use (conversation-actions.ts), which re-checks
// visibility and lets the row triggers send the realtime events.
// Ids only reach the audit log; no customer content is logged.
import { z } from 'zod';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import {
  assignConversations,
  labelConversations,
  markConversationsUnread,
  resolveConversations,
} from './conversation-actions';
import { matchingConversationIds } from './conversation-list';
import { parseListQuery } from './inbox-filters';
import { conversationVisible } from './visibility-sql';

/** The most conversations one "every conversation matching" action reaches. */
export const MAX_BULK_CONVERSATIONS = 5000;
/** Conversations changed per transaction. */
export const BULK_CHUNK = 500;
/** The most ticked ids one request names (ten pages of the list). */
export const MAX_BULK_IDS = 500;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform((id) => id.toLowerCase());

const bulkSchema = z.object({
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('assign'), agentId: uuid.nullable() }).strict(),
    z.object({ type: z.literal('resolve') }).strict(),
    z.object({ type: z.literal('label'), labelId: uuid }).strict(),
    z.object({ type: z.literal('read') }).strict(),
  ]),
  target: z.union([
    z.object({ ids: z.array(uuid).min(1).max(MAX_BULK_IDS) }).strict(),
    /** The list's query parameters (inbox-filters.ts listQueryParams). */
    z.object({ query: z.string().max(4000) }).strict(),
  ]),
}).strict();

export class BulkConversationError extends Error {
  constructor(readonly code: 'invalid_request' | 'too_many', readonly status = 400, readonly matched?: number) {
    super(code);
    this.name = 'BulkConversationError';
  }
}

export interface BulkConversationResult {
  /** Conversations the action was applied to (visible and in the workspace). */
  matched: number;
  /** Of those, how many changed (already resolved, assigned or labelled ones do not). */
  changed: number;
  /** Ticked ids the member may not act on (another workspace, hidden, or gone). */
  refusedIds: string[];
}

type Actor = TenantContext & { userId: string };

export async function bulkConversationAction(ctx: Actor, input: unknown): Promise<BulkConversationResult> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) throw new BulkConversationError('invalid_request');
  const { action, target } = parsed.data;

  const { ids, refusedIds } = await withTenant(ctx, async (tx) => {
    if ('ids' in target) {
      const wanted = [...new Set(target.ids)];
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT conversations.id::text AS id FROM conversations
        WHERE conversations.account_id=${ctx.accountId}::uuid AND conversations.id = ANY(${wanted}::uuid[])
          AND ${conversationVisible('conversations')}`;
      const allowed = new Set(rows.map((row) => row.id));
      return { ids: wanted.filter((id) => allowed.has(id)), refusedIds: wanted.filter((id) => !allowed.has(id)) };
    }
    const matching = await matchingConversationIds(tx, ctx, parseListQuery(new URLSearchParams(target.query)), MAX_BULK_CONVERSATIONS);
    if (matching.length > MAX_BULK_CONVERSATIONS) throw new BulkConversationError('too_many', 400, matching.length);
    return { ids: matching, refusedIds: [] as string[] };
  });

  let changed = 0;
  for (let start = 0; start < ids.length; start += BULK_CHUNK) {
    const chunk = ids.slice(start, start + BULK_CHUNK);
    changed += await withTenant(ctx, async (tx) => {
      let changedIds: string[];
      switch (action.type) {
        case 'assign':
          changedIds = await assignConversations(tx, ctx.accountId, chunk, action.agentId);
          break;
        case 'resolve':
          changedIds = await resolveConversations(tx, ctx.accountId, chunk);
          break;
        case 'label':
          changedIds = await labelConversations(tx, ctx.accountId, chunk, action.labelId);
          break;
        case 'read':
          changedIds = (await markConversationsUnread(tx, ctx.accountId, chunk, false)).map((row) => row.id);
          break;
      }
      const detail = {
        scope: 'ids' in target ? 'selected' : 'matching',
        requested: chunk.length,
        changed: changedIds.length,
        conversation_ids: changedIds,
        ...(action.type === 'assign' ? { agent_id: action.agentId } : {}),
        ...(action.type === 'label' ? { label_id: action.labelId } : {}),
      };
      await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
        VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, ${`inbox.bulk_${action.type}`}, NULL, ${JSON.stringify(detail)}::jsonb)`;
      return changedIds.length;
    });
  }
  return { matched: ids.length, changed, refusedIds };
}
