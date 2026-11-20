-- A contact's payments (chat side panel and contact profile, src/lib/contacts/commerce-summary.ts) include
-- payment links sent to that contact. Without this index that lookup scans every link of the workspace.
-- Built CONCURRENTLY so payment links stay writable while it builds.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block. If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index;
-- drop it (DROP INDEX CONCURRENTLY payment_links_contact_idx) and mark the migration rolled back before re-running.
CREATE INDEX CONCURRENTLY payment_links_contact_idx ON payment_links (account_id, contact_id) WHERE contact_id IS NOT NULL;
