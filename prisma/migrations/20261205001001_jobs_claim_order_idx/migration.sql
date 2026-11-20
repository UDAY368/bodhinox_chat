-- Standardisation batch 5: the worker's claim orders due jobs by (run_at, id) among pending and
-- running rows; this index matches that order and predicate, so a claim reads the first due row
-- instead of sorting. jobs_claim_idx (run_at, lease_until) stays.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY jobs_claim_order_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261205001001_jobs_claim_order_idx) before re-running.
CREATE INDEX CONCURRENTLY jobs_claim_order_idx
  ON jobs (run_at, id) WHERE status IN ('pending', 'running');
