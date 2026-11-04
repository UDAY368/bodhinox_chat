-- Phase 11: one Instagram conversation per (contact, Instagram account). A race
-- between two deliveries for the same IGSID ends in a unique violation and the
-- loser re-selects the winner.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- idx_conversations_ig_contact_account) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261109101200_conversations_ig_index)
-- before re-running.
CREATE UNIQUE INDEX CONCURRENTLY idx_conversations_ig_contact_account
  ON conversations (account_id, contact_id, instagram_account_id) WHERE channel = 'instagram';
