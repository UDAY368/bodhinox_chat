// Conversation assignment shared by rules (assign_conversation) and flows (assign_agent).
import type { DataClient } from '@/lib/data/types';
import { canOwnConversations, nextRoundRobinAgent } from '@/lib/automations/round-robin';

export type AssignMode = 'specific' | 'round_robin';

/**
 * The member to assign: the next in the workspace's round-robin, or the pinned member while
 * they can still own conversations (a member removed or demoted to viewer is refused, so the
 * conversation is left to routing). `no_agent` when the round-robin has nobody or none is pinned.
 */
export async function resolveAssignee(accountId: string, mode: AssignMode | string | undefined, agentId: string | null | undefined):
  Promise<{ agentId: string } | { refused: 'no_agent' | 'cannot_own'; agentId?: string }> {
  const picked = mode === 'round_robin' ? await nextRoundRobinAgent(accountId) : agentId ?? null;
  if (!picked) return { refused: 'no_agent' };
  if (mode !== 'round_robin' && !(await canOwnConversations(accountId, picked))) return { refused: 'cannot_own', agentId: picked };
  return { agentId: picked };
}

/**
 * Assigns the conversations `scope` picks (the run's conversation, or the contact's on a channel)
 * to `agentId`. The (account_id, assigned_agent_id) membership key rejects anyone outside the
 * workspace. `touch` also moves updated_at (flows do; rules never did).
 */
export async function assignConversations(db: DataClient, input: {
  accountId: string; agentId: string; touch: boolean;
  scope: { conversationId: string } | { contactId: string; channel: string; conversationId?: string };
}): Promise<{ error: unknown }> {
  const patch: Record<string, unknown> = { assigned_agent_id: input.agentId };
  if (input.touch) patch.updated_at = new Date().toISOString();
  let query = db.from('conversations').update(patch).eq('account_id', input.accountId);
  if ('contactId' in input.scope) {
    query = query.eq('contact_id', input.scope.contactId).eq('channel', input.scope.channel);
    if (input.scope.conversationId) query = query.eq('id', input.scope.conversationId);
  } else {
    query = query.eq('id', input.scope.conversationId);
  }
  const { error } = await query;
  return { error };
}
