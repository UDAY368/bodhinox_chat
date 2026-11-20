// Tag actions shared by rules (add_tag / remove_tag steps) and flows (set_tag step, the Actions
// step's add_tag / remove_tag). Both go through the one tag writer: a tag is added once, its
// tag_added rules (and, for flows, tag_added flows) dispatch only for a new tag and stop at
// MAX_TAG_CHAIN_DEPTH; a removal queues tag_removed with the run's contact event id so an
// automation never re-triggers itself.
import type { DataClient } from '@/lib/data/types';
import type { Channel } from '@/types';
import { addContactTagAndDispatch, type AddContactTagResult } from '@/lib/contacts/tag-events';
import { ContactTagWriteError, removeContactTag } from '@/lib/contacts/tag-write';
import type { AutomationContext } from '@/lib/automations/engine';

export { ContactTagWriteError } from '@/lib/contacts/tag-write';

export interface TagActionInput {
  db: DataClient;
  accountId: string;
  contactId: string;
  tagId: string;
}

/** Adds the tag (once) and dispatches tag_added. See addContactTagAndDispatch for the options. */
export function addTag(input: TagActionInput & {
  context?: AutomationContext; channel?: Channel; startFlows?: boolean;
}): Promise<AddContactTagResult> {
  return addContactTagAndDispatch(input);
}

export type RemoveTagOutcome = 'removed' | 'absent' | 'not_found';

/**
 * Removes the tag and queues tag_removed. A tag or contact that is not this workspace's (or was
 * deleted) is 'not_found'; any other error is thrown for the caller's retry.
 */
export async function removeTag(input: TagActionInput & { eventId?: string }): Promise<RemoveTagOutcome> {
  try {
    const { db, ...write } = input;
    return (await removeContactTag(db, write)) ? 'removed' : 'absent';
  } catch (error) {
    if (error instanceof ContactTagWriteError && error.status === 404) return 'not_found';
    throw error;
  }
}
