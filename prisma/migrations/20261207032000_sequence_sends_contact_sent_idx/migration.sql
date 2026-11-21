-- Campaigns (batch 7): "Skip people messaged in the last X days" also counts sequence messages sent to a contact.
-- Partial: only sent rows count.
--
-- Built CONCURRENTLY: the sequence worker writes sequence_message_sends continuously.
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- If a deploy is interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY
-- sequence_message_sends_contact_sent_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261207032000_sequence_sends_contact_sent_idx) before re-running.
CREATE INDEX CONCURRENTLY sequence_message_sends_contact_sent_idx ON sequence_message_sends (account_id, contact_id, updated_at) WHERE status = 'sent';
