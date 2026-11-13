import type { DataClient } from '@/lib/data/types';
import type { Channel } from '@/types';

import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine';
import { addContactTagIfAbsent } from './tag-write';
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

export { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

interface AddContactTagAndDispatchInput {
  db: DataClient;
  accountId: string;
  contactId: string;
  tagId: string;
  context?: AutomationContext;
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
    channel: await tagEventChannel(input),
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

  await startTagFlow(input, depth + 1);

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
