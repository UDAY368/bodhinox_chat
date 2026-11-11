// Who handled a conversation (team management, group 1): its assignments,
// resolves and reopens from conversation_handling_events (written only by the
// database trigger in 20261119000000), with each member's display name.
//
// Read inside the member's tenant transaction, so RLS keeps it to the
// workspace, and through the agent-visibility predicate, so an agent limited
// to their own chats cannot read another agent's history either. A member who
// has left the workspace keeps their id in the log; their name is null and the
// UI calls them a former member.
import { Prisma } from '@prisma/client';

import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { conversationVisible } from './visibility-sql';

export type HandlingKind = 'assigned' | 'unassigned' | 'resolved' | 'reopened';

export interface HandlingPerson {
  id: string;
  /** Null when the member has left the workspace. */
  name: string | null;
}

export interface HandlingEvent {
  id: string;
  kind: HandlingKind;
  from: HandlingPerson | null;
  to: HandlingPerson | null;
  /** Null: done automatically (routing, the worker, a customer message reopening it). */
  actor: HandlingPerson | null;
  at: string;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Conversation not found');
    this.name = 'ConversationNotFoundError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Newest events first; a long-lived chat's history is capped at this many rows. */
export const HANDLING_HISTORY_LIMIT = 200;

interface Row {
  id: string;
  kind: HandlingKind;
  from_user_id: string | null;
  to_user_id: string | null;
  actor_user_id: string | null;
  created_at: Date;
  from_name: string | null;
  to_name: string | null;
  actor_name: string | null;
  from_member: boolean;
  to_member: boolean;
  actor_member: boolean;
}

const person = (id: string | null, name: string | null, member: boolean): HandlingPerson | null =>
  id ? { id, name: member ? (name?.trim() || null) : null } : null;

export async function conversationHandlingHistory(ctx: TenantContext, conversationId: string): Promise<HandlingEvent[]> {
  if (!UUID.test(conversationId)) throw new ConversationNotFoundError();
  return withTenant(ctx, async (tx) => {
    const [visible] = await tx.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      SELECT true AS ok FROM conversations c
      WHERE c.account_id = ${ctx.accountId}::uuid AND c.id = ${conversationId}::uuid AND ${conversationVisible('c')}`);
    if (!visible) throw new ConversationNotFoundError();
    // A name is shown only while the person is still a member of this workspace.
    const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
      SELECT e.id::text, e.kind, e.from_user_id::text, e.to_user_id::text, e.actor_user_id::text, e.created_at,
        pf.full_name AS from_name, pt.full_name AS to_name, pa.full_name AS actor_name,
        (mf.user_id IS NOT NULL) AS from_member, (mt.user_id IS NOT NULL) AS to_member, (ma.user_id IS NOT NULL) AS actor_member
      FROM conversation_handling_events e
      LEFT JOIN account_memberships mf ON mf.account_id = e.account_id AND mf.user_id = e.from_user_id
      LEFT JOIN account_memberships mt ON mt.account_id = e.account_id AND mt.user_id = e.to_user_id
      LEFT JOIN account_memberships ma ON ma.account_id = e.account_id AND ma.user_id = e.actor_user_id
      LEFT JOIN profiles pf ON pf.user_id = mf.user_id
      LEFT JOIN profiles pt ON pt.user_id = mt.user_id
      LEFT JOIN profiles pa ON pa.user_id = ma.user_id
      WHERE e.account_id = ${ctx.accountId}::uuid AND e.conversation_id = ${conversationId}::uuid
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${HANDLING_HISTORY_LIMIT}`);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      from: person(r.from_user_id, r.from_name, r.from_member),
      to: person(r.to_user_id, r.to_name, r.to_member),
      actor: person(r.actor_user_id, r.actor_name, r.actor_member),
      at: new Date(r.created_at).toISOString(),
    }));
  });
}

/** The most conversation ids one "Handled by" lookup returns. */
export const HANDLED_BY_LIMIT = 5000;

/**
 * Ids of the conversations, visible to the caller, that `memberId` handled:
 * assigned to them now or at any time, resolved by them, an assignment they
 * made, or a message they sent. Empty for a malformed id or someone outside
 * the workspace (their rows are not in it).
 */
export async function conversationsHandledBy(ctx: TenantContext, memberId: string): Promise<string[]> {
  if (!UUID.test(memberId)) return [];
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT c.id::text FROM conversations c
      WHERE c.account_id = ${ctx.accountId}::uuid AND ${conversationVisible('c')}
        AND (c.assigned_agent_id = ${memberId}::uuid OR c.resolved_by = ${memberId}::uuid
          OR EXISTS (SELECT 1 FROM conversation_handling_events e
            WHERE e.account_id = c.account_id AND e.conversation_id = c.id
              AND (e.to_user_id = ${memberId}::uuid OR e.actor_user_id = ${memberId}::uuid))
          OR EXISTS (SELECT 1 FROM messages m
            WHERE m.account_id = c.account_id AND m.sender_id = ${memberId}::uuid AND m.conversation_id = c.id))
      ORDER BY c.last_message_at DESC NULLS LAST, c.id
      LIMIT ${HANDLED_BY_LIMIT}`);
    return rows.map((r) => r.id);
  });
}
