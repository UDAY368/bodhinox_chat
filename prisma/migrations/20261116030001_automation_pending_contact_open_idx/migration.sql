-- Serves the contacts_expire_automation_waits trigger (20261116030000): the
-- open waits of one contact, by tenant. idx_automation_pending_awaiting_reply
-- covers only awaiting_reply rows.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- idx_automation_pending_contact_open) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261116030001_automation_pending_contact_open_idx)
-- before re-running.
CREATE INDEX CONCURRENTLY idx_automation_pending_contact_open
  ON automation_pending_executions (account_id, contact_id) WHERE status IN ('pending','awaiting_reply');
