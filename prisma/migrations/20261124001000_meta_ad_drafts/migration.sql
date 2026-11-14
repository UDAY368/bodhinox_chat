SET LOCAL lock_timeout = '5s';

-- Ads module, ad creation (part E). Additive: meta_ad_drafts, one row per ad an
-- admin creates from Bodhinox (click-to-WhatsApp, click-to-Instagram-Direct,
-- instant-form lead, or website traffic). The row and its meta.ad_create job
-- commit together; the worker creates the campaign, ad set, creative and ad in
-- that order, each through its own outbound intent, storing each Meta id as it
-- goes so a retry continues where it stopped. An ambiguous outcome is settled
-- by looking the object up by name, never by creating it again; if that is
-- unclear too the row is 'unknown' until an admin re-checks or discards it.
-- Nothing here calls Meta unless META_ADS_ENABLED and META_ADS_MANAGE_ENABLED
-- are set.

CREATE TABLE meta_ad_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^\d{1,32}$'),
  page_id text NOT NULL CHECK (page_id ~ '^\d{1,32}$'),
  kind text NOT NULL CHECK (kind IN ('whatsapp','instagram_direct','lead_form','website')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  daily_budget_minor bigint NOT NULL CHECK (daily_budget_minor > 0 AND daily_budget_minor < 1000000000000000),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  countries text[] NOT NULL CHECK (cardinality(countries) BETWEEN 1 AND 25),
  age_min int NOT NULL CHECK (age_min BETWEEN 18 AND 65),
  age_max int NOT NULL CHECK (age_max BETWEEN 18 AND 65),
  -- 1 = men, 2 = women (Meta's codes); empty = everyone.
  genders int[] NOT NULL DEFAULT '{}',
  primary_text text NOT NULL CHECK (char_length(primary_text) BETWEEN 1 AND 2000),
  headline text CHECK (char_length(headline) <= 255),
  description text CHECK (char_length(description) <= 255),
  link_url text CHECK (char_length(link_url) <= 2048 AND link_url ~ '^https://'),
  lead_form_id text CHECK (lead_form_id ~ '^\d{1,32}$'),
  cta_type text NOT NULL CHECK (cta_type ~ '^[A-Z_]{2,40}$'),
  image_hash text NOT NULL CHECK (image_hash ~ '^[0-9a-f]{16,64}$'),
  image_url text CHECK (char_length(image_url) <= 2048 AND image_url ~ '^https://'),
  whatsapp_number text CHECK (whatsapp_number ~ '^\+[1-9]\d{6,14}$'),
  welcome_message text CHECK (char_length(welcome_message) <= 300),
  -- true: created live (ACTIVE, then Meta reviews it); false: created paused.
  publish boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','created','failed','unknown','discarded')),
  -- The next step to run; 'done' once the ad exists.
  step text NOT NULL DEFAULT 'campaign' CHECK (step IN ('campaign','adset','creative','ad','done')),
  campaign_id text CHECK (campaign_id ~ '^\d{1,32}$'),
  adset_id text CHECK (adset_id ~ '^\d{1,32}$'),
  creative_id text CHECK (creative_id ~ '^\d{1,32}$'),
  ad_id text CHECK (ad_id ~ '^\d{1,32}$'),
  last_error_code text CHECK (last_error_code ~ '^[0-9:a-z_]{0,40}$'),
  requested_by uuid NOT NULL,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id),
  CHECK (age_min <= age_max),
  CHECK (end_time IS NULL OR end_time > start_time),
  CHECK (genders <@ ARRAY[1,2]),
  CHECK (kind <> 'website' OR link_url IS NOT NULL),
  CHECK (kind <> 'lead_form' OR lead_form_id IS NOT NULL),
  CHECK (status <> 'created' OR ad_id IS NOT NULL),
  CHECK (status <> 'discarded' OR resolved_by IS NOT NULL)
);
CREATE INDEX meta_ad_drafts_recent ON meta_ad_drafts(account_id, created_at DESC);

ALTER TABLE meta_ad_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_drafts FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Writes run as the worker after the route's admin, membership and CSRF checks.
CREATE POLICY worker_write ON meta_ad_drafts FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_drafts TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON meta_ad_drafts TO bodhinox_worker;
