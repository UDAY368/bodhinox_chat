-- Batch 7 duplicate finder: numbers with a 0 right after a 1-3 digit country code, the only ones that can be the
-- trunk-prefixed form of another contact's number (phoneVariants in src/lib/whatsapp/phone-utils.ts). The other side
-- of each pair is found through the unique (account_id, phone_normalized) index.
-- One statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. If a deploy is
-- interrupted mid-build, drop the INVALID index (DROP INDEX CONCURRENTLY contacts_trunk_phone_idx) and mark the
-- migration rolled back before re-running.
CREATE INDEX CONCURRENTLY contacts_trunk_phone_idx ON contacts (account_id, phone_normalized) WHERE phone_normalized ~ '^[0-9]{1,3}0[0-9]';
