-- Instagram Phase 1 (Stage 2): the profile facts the follow gate (and, in
-- Stage 3, segments) read, per Instagram identity.
--
--   follows_business    the person follows the business account
--   business_follows    the business account follows the person
--   is_verified         the person's account is verified
--   ig_follower_count   their follower count
--   profile_checked_at  when these were last read from Meta (null: never)
-- Null means unknown (never read, or Meta did not return it). The worker
-- writes them (profile.ts, as the worker inside withTenant); members read
-- them through the table-level SELECT grant. The app role's column grant
-- stays UPDATE (contact_id, updated_at): members cannot write the facts. RLS
-- is unchanged. The count check is NOT VALID (every row is null) and validated
-- by 20261117070700_instagram_phase1_validate. Additive: nullable columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contact_channel_identities ADD COLUMN follows_business boolean;
ALTER TABLE contact_channel_identities ADD COLUMN business_follows boolean;
ALTER TABLE contact_channel_identities ADD COLUMN is_verified boolean;
ALTER TABLE contact_channel_identities ADD COLUMN ig_follower_count integer;
ALTER TABLE contact_channel_identities ADD COLUMN profile_checked_at timestamptz;
ALTER TABLE contact_channel_identities ADD CONSTRAINT contact_channel_identities_ig_follower_count_check
  CHECK (ig_follower_count >= 0) NOT VALID;
