-- Instagram Phase 2 (Stage 3): the ref link a person last opened a chat from,
-- per Instagram identity (a contact field, and the ig_ref flow trigger's key).
--
--   last_ref     the ref key from https://ig.me/m/<username>?ref=<key> (or a
--                click-to-Direct ad that carries one), as Meta passed it.
--                Only a-z, A-Z, 0-9 and +/=-.:_ up to 250 characters, which is
--                what Meta allows (src/lib/instagram/ref-links.ts
--                IG_REF_STORED); the worker drops anything else.
--   last_ref_at  when it arrived.
-- Null means none yet. The worker writes them inside withTenant; members read
-- them through the table-level SELECT grant. The app role's column grant stays
-- UPDATE (contact_id, updated_at): members cannot write them. RLS is
-- unchanged. The check is NOT VALID (every row is null) and validated by
-- 20261117130800_instagram_phase2_validate. Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contact_channel_identities ADD COLUMN last_ref text;
ALTER TABLE contact_channel_identities ADD COLUMN last_ref_at timestamptz;
ALTER TABLE contact_channel_identities ADD CONSTRAINT contact_channel_identities_last_ref_check
  CHECK (last_ref ~ '^[A-Za-z0-9_=+/.:-]{1,250}$') NOT VALID;
