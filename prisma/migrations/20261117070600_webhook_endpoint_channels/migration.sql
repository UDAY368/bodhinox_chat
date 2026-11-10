-- Instagram Phase 1 (Stage 2): which channels' events an outbound webhook
-- endpoint receives.
--
-- The constant default '{whatsapp}' fills every existing endpoint without a
-- table rewrite, so existing consumers never receive Instagram events they did
-- not opt into. An endpoint lists one or both channels. Grants are table-level
-- (the endpoint routes run server-side; webhook_endpoints is server-only in
-- src/lib/data/contracts.ts) and RLS is unchanged. The check is NOT VALID and
-- validated by 20261117070700_instagram_phase1_validate. Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE webhook_endpoints ADD COLUMN channels text[] NOT NULL DEFAULT '{whatsapp}';
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_channels_check
  CHECK (cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['whatsapp','instagram']::text[]) NOT VALID;
