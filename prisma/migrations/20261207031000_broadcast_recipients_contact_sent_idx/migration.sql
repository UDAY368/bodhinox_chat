-- Campaigns (batch 7): "Skip people messaged in the last X days" looks up each contact's latest campaign send.
-- Partial: rows never sent have no sent_at.
--
-- Built CONCURRENTLY: delivery workers and status webhooks write broadcast_recipients continuously.
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- If a deploy is interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY
-- broadcast_recipients_contact_sent_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207031000_broadcast_recipients_contact_sent_idx) before re-running.
CREATE INDEX CONCURRENTLY broadcast_recipients_contact_sent_idx ON broadcast_recipients (account_id, contact_id, sent_at) WHERE sent_at IS NOT NULL;
