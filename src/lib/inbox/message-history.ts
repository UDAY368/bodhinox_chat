import type { DataClient } from '@/lib/data/types';
import type { Message } from '@/types';
export const MESSAGE_PAGE_SIZE = 50;
export async function loadMessagePage(
  db: DataClient,
  conversationId: string,
  before?: Pick<Message, 'id' | 'created_at'>
) {
  let query = db
    .from('messages')
    .select<Message>('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE_SIZE);
  if (before)
    query = query.or(
      `created_at.lt.${before.created_at},and(created_at.eq.${before.created_at},id.lt.${before.id})`
    );
  const result = await query;
  return { ...result, data: result.data ? [...result.data].reverse() : null };
}

export interface ThreadHistory {
  conversationId: string;
  before: Pick<Message, 'id' | 'created_at'> | undefined;
  hasOlder: boolean;
}

/**
 * The 'load older' cursor after the newest page was (re)fetched. A resync of
 * the thread already shown keeps the cursor when the fresh page overlaps the
 * messages on screen (they stay, and older pages continue from where the agent
 * scrolled). A first load, another conversation, or a gap (more new messages
 * than one page) starts again from the fetched page.
 */
export function historyAfterNewestPage(
  previous: ThreadHistory | null,
  conversationId: string,
  page: Message[],
  shownIds: ReadonlySet<string>
): ThreadHistory {
  if (previous?.conversationId === conversationId && page.some((m) => shownIds.has(m.id)))
    return previous;
  return { conversationId, before: page[0], hasOlder: page.length === MESSAGE_PAGE_SIZE };
}

/** Within this many pixels of the end, the thread follows new messages. */
export const STICK_TO_BOTTOM_PX = 80;

export function isNearBottom(
  el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
}
