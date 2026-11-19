-- The Sales board reads one pipeline's deals per status and stage, newest first, a page at a
-- time (src/lib/pipelines/board.ts). deals had no index beyond its keys, so every board read
-- scanned the workspace's deals. Built CONCURRENTLY so deals stay writable while it builds.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY deals_board_idx) and mark the migration rolled back before re-running.
CREATE INDEX CONCURRENTLY deals_board_idx ON deals (account_id, pipeline_id, stage_id, status, created_at DESC, id);
