-- Standardisation batch 5: the claim's per-key check (is a job of this lane_key running, or an
-- older one still due?) reads this small partial index instead of scanning the queue.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY jobs_lane_key_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261205001002_jobs_lane_key_idx) before re-running.
CREATE INDEX CONCURRENTLY jobs_lane_key_idx
  ON jobs (lane_key, run_at, id) WHERE lane_key IS NOT NULL AND status IN ('pending', 'running');
