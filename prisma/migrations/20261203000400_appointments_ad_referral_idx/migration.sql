-- Bookings credited to an ad click.
CREATE INDEX CONCURRENTLY appointments_ad_referral_idx ON appointments (account_id, ad_referral_id) WHERE ad_referral_id IS NOT NULL;
