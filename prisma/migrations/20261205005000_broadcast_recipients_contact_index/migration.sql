-- Campaign sales (src/lib/broadcasts/attribution.ts): for each paid order, the latest campaign the
-- order's contact received in the 7 days before it. Without this index that lookup scans every
-- recipient row of the workspace per order (over three minutes on 500,000 rows; about 0.6 s with it).
-- Built CONCURRENTLY: delivery workers and status webhooks write broadcast_recipients continuously.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index; drop it
-- (DROP INDEX CONCURRENTLY broadcast_recipients_contact_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261205005000_broadcast_recipients_contact_index) before re-running.
CREATE INDEX CONCURRENTLY broadcast_recipients_contact_idx ON broadcast_recipients (account_id, contact_id) WHERE contact_id IS NOT NULL;
