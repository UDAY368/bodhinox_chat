-- Who handled which chat (team management, group 1): the inbox's "Handled by"
-- filter lists the conversations a member sent a message in, by sender_id.
-- Only member-sent rows carry sender_id, so the index is partial and small.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- messages_sender_conversation_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261119000100_messages_sender_index)
-- before re-running.
CREATE INDEX CONCURRENTLY messages_sender_conversation_idx
  ON messages (account_id, sender_id, conversation_id) WHERE sender_id IS NOT NULL;
