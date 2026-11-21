-- Batch 7: the inbox conversation list is paged in SQL (src/lib/inbox/conversation-list.ts),
-- keyset pages in the list's order: latest activity first, then id. This index
-- serves that order per workspace, so a page reads about one page of rows
-- instead of sorting every conversation of the workspace.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- conversations_list_order_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207040000_conversations_list_order_index)
-- before re-running.
CREATE INDEX CONCURRENTLY conversations_list_order_idx
  ON conversations (account_id, last_message_at DESC NULLS LAST, id);
