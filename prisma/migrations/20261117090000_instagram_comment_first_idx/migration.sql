-- Instagram Phase 1 (Stage 2, batch 2C): an ig_comment flow starts only on a
-- person's first comment on a post. The webhook processor checks that on every
-- comment it records (process-webhook.ts commentFlowChoices) by looking for an
-- earlier comment event of the same account, post and commenter; this index
-- serves that lookup, which would otherwise read every comment the account ever
-- received.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and it does not block comment writes.
-- If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY instagram_comment_events_first_idx) and mark
-- the migration rolled back (prisma migrate resolve --rolled-back
-- 20261117090000_instagram_comment_first_idx) before re-running. Additive.
CREATE INDEX CONCURRENTLY instagram_comment_events_first_idx
  ON instagram_comment_events (account_id, instagram_account_id, media_id, from_igsid);
