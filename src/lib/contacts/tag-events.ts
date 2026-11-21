import type { DataClient } from '@/lib/data/types';
import type { Channel } from '@/types';

import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { exitSequencesFor } from '@/lib/sequences/subscriptions';
import { addContactTagIfAbsent } from './tag-write';
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

export { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

interface AddContactTagAndDispatchInput {
  db: DataClient;
  accountId: string;
  contactId: string;
  tagId: string;
  context?: AutomationContext;
  /** The channel of the tag_added event when the caller knows it (a rule's own channel); else read from the conversation. */
  channel?: Channel;
  /** Also start a tag_added flow (default). A rule's add_tag step dispatches rules only, as it always did. */
  startFlows?: boolean;
}

export interface AddContactTagResult {
  added: boolean;
  dispatched: boolean;
  reason?: 'duplicate' | 'max_depth';
}

/**
 * The channel a tag_added event belongs to: its conversation's (from the row,
 * scoped to the account), WhatsApp when it names none or the row is a
 * pre-Phase 11 one. Never throws, like the dispatch it feeds (the tag is
 * already written): a failed lookup falls back to WhatsApp, and the engine
 * then refuses the event if the conversation is on another channel.
 */
async function tagEventChannel(input: AddContactTagAndDispatchInput): Promise<Channel> {
  const conversationId = input.context?.conversation_id;
  if (!conversationId) return 'whatsapp';
  try {
    const { data, error } = await input.db
      .from('conversations')
      .select('channel')
      .eq('account_id', input.accountId)
      .eq('id', conversationId)
      .maybeSingle();
    if (error) throw error;
    return (data as { channel?: string | null } | null)?.channel === 'instagram' ? 'instagram' : 'whatsapp';
  } catch {
    // Ids only: never the error text, which can carry query values.
    console.error('[automations] tag event channel lookup failed', { accountId: input.accountId, conversationId });
    return 'whatsapp';
  }
}

/**
 * Central server-side tag writer. It dispatches tag_added only for a
 * newly-created join and caps chained tag automations to avoid loops.
 */
export async function addContactTagAndDispatch(
  input: AddContactTagAndDispatchInput
): Promise<AddContactTagResult> {
  const added = await addContactTagIfAbsent(input.db, {
    accountId: input.accountId,
    contactId: input.contactId,
    tagId: input.tagId,
  });

  if (!added) return { added: false, dispatched: false, reason: 'duplicate' };
  await exitTaggedSequences(input);

  const depth = getTagChainDepth(input.context);
  if (depth >= MAX_TAG_CHAIN_DEPTH) {
    console.warn('[automations] tag_added chain depth limit reached', {
      accountId: input.accountId,
      contactId: input.contactId,
      tagId: input.tagId,
      depth,
    });
    return { added: true, dispatched: false, reason: 'max_depth' };
  }

  await runAutomationsForTrigger({
    accountId: input.accountId,
    channel: input.channel ?? await tagEventChannel(input),
    triggerType: 'tag_added',
    contactId: input.contactId,
    context: {
      ...input.context,
      tag_id: input.tagId,
      vars: {
        ...(input.context?.vars ?? {}),
        _tag_chain_depth: depth + 1,
      },
    },
  });

  if (input.startFlows !== false) await startTagFlow(input, depth + 1);

  return { added: true, dispatched: true };
}

/**
 * The tag_added flow trigger: a flow starts on the conversation the tag was
 * added in, or (from the contacts page or the API) the contact's most recently
 * active conversation; a contact with none starts no flow. Never throws: the
 * tag is already written and the rules above already ran. Ids only in the log.
 */
async function startTagFlow(input: AddContactTagAndDispatchInput, chainDepth: number): Promise<void> {
  const conversationId = input.context?.conversation_id;
  try {
    // Loaded on use: the flow engine imports this module (its tag steps write through it).
    const { startTagAddedFlows } = await import('@/lib/flows/engine');
    await startTagAddedFlows({
      accountId: input.accountId,
      contactId: input.contactId,
      conversationId,
      tagId: input.tagId,
      chainDepth,
    });
  } catch {
    console.error('[flows] tag_added start failed', { accountId: input.accountId, contactId: input.contactId, tagId: input.tagId });
  }
}

/**
 * Sequences set to "Exit when tagged" with this tag stop for the contact. Never
 * throws (the tag is already written): the sequence worker checks the same
 * rule before every step. Ids only in the log.
 */
async function exitTaggedSequences(input: AddContactTagAndDispatchInput): Promise<void> {
  try {
    await withTenant({ accountId: input.accountId, role: 'owner' }, (tx) => exitSequencesFor(tx, {
      accountId: input.accountId, contactId: input.contactId, reason: 'tagged', tagId: input.tagId,
    }), getWorkerPrisma());
  } catch {
    console.error('[sequences] tag exit failed', { accountId: input.accountId, contactId: input.contactId, tagId: input.tagId });
  }
}
