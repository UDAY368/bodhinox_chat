-- Instagram Phase 2 (Stage 3): Instagram › Insights counts a workspace's
-- comments over a date range (per post and per flow); this index serves that
-- range instead of a scan of every comment the workspace ever received.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and it does not block comment writes.
-- If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY instagram_comment_events_received_idx) and
-- mark the migration rolled back (prisma migrate resolve --rolled-back
-- 20261117130700_instagram_comment_received_idx) before re-running. Additive.
CREATE INDEX CONCURRENTLY instagram_comment_events_received_idx
  ON instagram_comment_events (account_id, received_at);
