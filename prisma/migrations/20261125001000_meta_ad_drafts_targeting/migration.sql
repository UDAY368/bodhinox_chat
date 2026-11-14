SET LOCAL lock_timeout = '5s';

-- Ads gaps, phase 2: richer targeting and ad formats for ads created in
-- Bodhinox. Additive columns on meta_ad_drafts (worker writes only, as before):
-- placements (empty = Meta's automatic placements; whatsapp_status is the
-- WhatsApp Status placement), interests, cities/regions and languages chosen
-- from Meta's targeting search, and the ad format: one image (as before), one
-- video (uploaded to the ad account; image_hash is its thumbnail) or a carousel
-- of 2-10 cards (image_hash is the first card's image). Existing drafts keep
-- 'image' and empty targeting, so they behave exactly as before.

ALTER TABLE meta_ad_drafts ADD COLUMN format text NOT NULL DEFAULT 'image';
ALTER TABLE meta_ad_drafts ADD COLUMN video_id text;
ALTER TABLE meta_ad_drafts ADD COLUMN cards jsonb;
ALTER TABLE meta_ad_drafts ADD COLUMN placements text[] NOT NULL DEFAULT '{}';
ALTER TABLE meta_ad_drafts ADD COLUMN interests jsonb NOT NULL DEFAULT '[]';
ALTER TABLE meta_ad_drafts ADD COLUMN places jsonb NOT NULL DEFAULT '[]';
ALTER TABLE meta_ad_drafts ADD COLUMN locales int[] NOT NULL DEFAULT '{}';

ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_format_check CHECK (
  format IN ('image','video','carousel')
  AND (video_id IS NULL OR video_id ~ '^\d{1,32}$')
  AND (format <> 'video' OR video_id IS NOT NULL)
  AND (format <> 'carousel' OR (jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) BETWEEN 2 AND 10))
  AND (cards IS NULL OR pg_column_size(cards) <= 32768)
) NOT VALID;
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_targeting_check CHECK (
  placements <@ ARRAY['facebook','instagram','messenger','audience_network','whatsapp_status']::text[]
  AND jsonb_typeof(interests) = 'array' AND jsonb_array_length(interests) <= 25
  AND jsonb_typeof(places) = 'array' AND jsonb_array_length(places) <= 25
  AND cardinality(locales) <= 10
  AND pg_column_size(interests) + pg_column_size(places) <= 32768
) NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_format_check;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_targeting_check;
