'use client';

// Browser side of the server-paged inbox list (GET /api/inbox/conversations)
// and its bulk actions (POST /api/inbox/conversations/bulk).
import { authFetch } from '@/lib/auth/client';
import type { InboxListCounts } from '@/lib/inbox/conversation-list';
import type { Conversation } from '@/types';

export type { InboxListCounts };

export interface ListPage {
  conversations: Conversation[];
  nextCursor: string | null;
  counts?: InboxListCounts;
  companies?: string[];
}

export interface ListChanges {
  conversations: Conversation[];
  removedIds: string[];
  overflow: boolean;
  counts?: InboxListCounts;
}

const LIST_URL = '/api/inbox/conversations';

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`list ${res.status}`);
  return (await res.json()) as T;
}

/** One page of the list for these list parameters (listQueryParams); the first page has counts. */
export function fetchListPage(params: string, cursor?: string | null): Promise<ListPage> {
  const search = new URLSearchParams(params);
  if (cursor) search.set('cursor', cursor);
  return getJson<ListPage>(`${LIST_URL}?${search}`);
}

/** Which of these conversations match the list now (at most 100 ids). */
export function fetchListMatches(params: string, ids: string[]): Promise<ListChanges> {
  const search = new URLSearchParams(params);
  search.set('ids', ids.join(','));
  return getJson<ListChanges>(`${LIST_URL}?${search}`);
}

/** The conversations changed since `since`, with fresh counts. */
export function fetchListChanges(params: string, since: string): Promise<ListChanges> {
  const search = new URLSearchParams(params);
  search.set('since', since);
  search.set('counts', '1');
  return getJson<ListChanges>(`${LIST_URL}?${search}`);
}

export type BulkAction =
  | { type: 'assign'; agentId: string | null }
  | { type: 'resolve' }
  | { type: 'label'; labelId: string }
  | { type: 'read' };

export interface BulkResult {
  matched: number;
  changed: number;
  refusedIds: string[];
}

export class BulkRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function postBulkAction(action: BulkAction, target: { ids: string[] } | { query: string }): Promise<BulkResult> {
  const res = await authFetch(`${LIST_URL}/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, target }),
  });
  const body = (await res.json().catch(() => null)) as (BulkResult & { error?: string }) | null;
  if (!res.ok || !body) throw new BulkRequestError(body?.error ?? 'failed');
  return body;
}
