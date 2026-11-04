-- Phase 12: "has this contact already run this automation?" for scheduled
-- segment enrollment with once_per_contact.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- automation_logs_automation_contact_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261110100500_automation_logs_contact_index)
-- before re-running.
CREATE INDEX CONCURRENTLY automation_logs_automation_contact_idx
  ON automation_logs (account_id, automation_id, contact_id);
