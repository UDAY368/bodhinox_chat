-- One campaign per (workspace, client request id); rows without an id (API, Instagram and older
-- campaigns, drafts) are never in conflict because NULLs are distinct.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- broadcasts_account_client_request_id_key) and mark the migration rolled
-- back (prisma migrate resolve --rolled-back
-- 20261201100100_campaign_client_request_id_idx) before re-running.
CREATE UNIQUE INDEX CONCURRENTLY broadcasts_account_client_request_id_key
  ON broadcasts (account_id, client_request_id);
