-- Instagram Phase 2 (Stage 3): the funnel writers (comment-funnel.ts) and the
-- per-flow funnel find a comment by the run it started; without this index
-- every write would read all of the workspace's comments.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and it does not block comment writes.
-- If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY instagram_comment_events_run_idx) and mark
-- the migration rolled back (prisma migrate resolve --rolled-back
-- 20261117130600_instagram_comment_run_idx) before re-running. Additive.
CREATE INDEX CONCURRENTLY instagram_comment_events_run_idx
  ON instagram_comment_events (account_id, flow_run_id) WHERE flow_run_id IS NOT NULL;
