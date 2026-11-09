-- Data retention: the hourly retention sweep deletes done jobs older than 30 days and
-- failed jobs older than 90 days in batches. The predicate matches its filters, so each
-- batch reads the index instead of scanning the queue table.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- jobs_finished_updated_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261116100200_jobs_finished_updated_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY jobs_finished_updated_idx
  ON jobs (status, updated_at) WHERE status IN ('done', 'failed');
