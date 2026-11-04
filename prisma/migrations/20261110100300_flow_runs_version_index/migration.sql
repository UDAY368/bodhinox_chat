-- Phase 12: active runs per published version (version list counts, migrate
-- and cancel by version).
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- flow_runs_version_active_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261110100300_flow_runs_version_index)
-- before re-running.
CREATE INDEX CONCURRENTLY flow_runs_version_active_idx
  ON flow_runs (account_id, flow_version_id) WHERE status = 'active';
