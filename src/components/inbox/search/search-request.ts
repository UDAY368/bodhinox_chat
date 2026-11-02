// Network and jump-request helpers for inbox search, kept out of the
// component so they can be tested without a DOM.

import { authFetch } from '@/lib/auth/client';
import type { InboxSearchHitDto } from './inbox-search';

export type SearchFailure = 'error' | 'rate_limited';

export type SearchPageResult =
  | { ok: true; results: InboxSearchHitDto[]; nextCursor: string | null }
  | { ok: false; failure: SearchFailure };

/**
 * One page of GET /api/inbox/search. authFetch refreshes an expired access
 * token once on 401 and retries. Abort errors are rethrown so the caller can
 * drop superseded requests; any other failure becomes a SearchFailure.
 */
export async function fetchSearchPage(url: string, signal: AbortSignal): Promise<SearchPageResult> {
  let res: Response;
  try {
    res = await authFetch(url, { signal, cache: 'no-store' });
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, failure: 'error' };
  }
  if (res.status === 429) return { ok: false, failure: 'rate_limited' };
  if (!res.ok) return { ok: false, failure: 'error' };
  try {
    const data = (await res.json()) as { results: InboxSearchHitDto[]; next_cursor: string | null };
    return { ok: true, results: data.results, nextCursor: data.next_cursor };
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, failure: 'error' };
  }
}

/** A request for the thread to scroll to a search hit, bound to its conversation. */
export interface JumpRequest {
  conversationId: string;
  messageId: string;
  nonce: number;
}

/**
 * The jump the open thread should perform: only a request made for the
 * conversation that is open now, so a stale request never replays in
 * another conversation.
 */
export function jumpRequestFor(
  request: JumpRequest | null,
  activeConversationId: string | null | undefined
): { messageId: string; nonce: number } | null {
  if (!request || !activeConversationId || request.conversationId !== activeConversationId) return null;
  return { messageId: request.messageId, nonce: request.nonce };
}
