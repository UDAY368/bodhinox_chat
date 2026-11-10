-- Channel separation (Stage 1): every automation belongs to one channel.
--
-- The constant default fills every existing row as 'whatsapp' without a table
-- rewrite (PostgreSQL 11+ keeps it in the catalogue), so existing automations
-- keep running exactly as before. There is no 'any': an automation lives in one
-- section. automation_steps, automation_logs and automation_pending_executions
-- follow their automation and get no column. Grants on automations are
-- table-level (foundation), so the new column needs no grant.
--
-- The CHECK is added NOT VALID (no scan while the ADD COLUMN lock is held) and
-- validated in 20261117010200_automation_channel_validate. The index is built
-- CONCURRENTLY in 20261117010300_automations_account_channel_idx; the old
-- idx_automations_account_active_trigger stays.
--
-- Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE automations ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE automations ADD CONSTRAINT automations_channel_check
  CHECK (channel IN ('whatsapp','instagram')) NOT VALID;
