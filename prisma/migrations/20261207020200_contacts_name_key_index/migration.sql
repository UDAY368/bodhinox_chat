-- Batch 7 duplicate finder: an Instagram-only contact and a WhatsApp-only contact with the same name.
-- Queries must use exactly lower(btrim(name)) and the same predicate (src/lib/contacts/duplicates.ts).
-- One statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. If a deploy is
-- interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY contacts_name_key_idx) and mark the
-- migration rolled back before re-running.
CREATE INDEX CONCURRENTLY contacts_name_key_idx ON contacts (account_id, lower(btrim(name))) WHERE btrim(COALESCE(name, '')) <> '';
