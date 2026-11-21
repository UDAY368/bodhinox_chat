-- Batch 7 duplicate finder: contacts sharing an email address (case and spaces ignored).
-- Queries must use exactly lower(btrim(email)) and the same predicate (src/lib/contacts/duplicates.ts).
-- One statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. If a deploy is
-- interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY contacts_email_key_idx) and mark the
-- migration rolled back before re-running.
CREATE INDEX CONCURRENTLY contacts_email_key_idx ON contacts (account_id, lower(btrim(email))) WHERE btrim(COALESCE(email, '')) <> '';
