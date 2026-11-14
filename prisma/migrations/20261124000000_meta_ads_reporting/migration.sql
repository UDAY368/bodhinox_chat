SET LOCAL lock_timeout = '5s';

-- Ads module, reporting (part B/C/D). Additive:
--   * meta_ad_accounts: the ad accounts a workspace reports on and manages.
--     One login (meta_ad_connections) may now bring several ad accounts; the
--     connection's ad_account_id stays the primary one and is copied in here.
--   * meta_ad_insights: the ad account each row belongs to, ad set rows
--     (level 'adset'), the ad set of ad rows, and link clicks, leads and
--     Meta-reported purchases beside conversations started.
--   * meta_ad_insight_platforms: daily campaign figures split by placement
--     platform (Facebook, Instagram, Messenger, Audience Network, WhatsApp,
--     Threads), from Meta's publisher_platform breakdown.
--   * meta_ad_reach: reach and frequency for fixed ranges (7, 30, 90 days),
--     which cannot be summed from daily rows (reach counts unique people).
--   * meta_ad_objects: the ad account of each object, the ad set's destination
--     and optimisation goal, and the ad's creative (thumbnail, image, text and
--     call to action) for previews.
-- Every table is tenant-scoped with FORCE RLS; members read, only the worker
-- writes (it syncs from Meta, or applies an admin's change after the route's
-- checks). Nothing here calls Meta unless META_ADS_ENABLED is set.

CREATE TABLE meta_ad_accounts (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^\d{1,32}$'),
  name text CHECK (char_length(name) <= 500),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  business_id text CHECK (business_id ~ '^\d{1,32}$'),
  is_primary boolean NOT NULL DEFAULT false,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  insights_synced_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[0-9:]{0,32}$'),
  PRIMARY KEY (account_id, ad_account_id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);
-- At most one primary ad account per workspace.
CREATE UNIQUE INDEX meta_ad_accounts_one_primary ON meta_ad_accounts(account_id) WHERE is_primary;

ALTER TABLE meta_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_accounts FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_accounts FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_accounts TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_accounts TO bodhinox_worker;

-- Every live connection with a chosen ad account becomes its workspace's primary ad account.
INSERT INTO meta_ad_accounts(account_id, connection_id, ad_account_id, name, currency, business_id, is_primary, added_by, added_at, insights_synced_at)
SELECT account_id, id, ad_account_id, ad_account_name, ad_account_currency, business_id, true, connected_by, coalesce(connected_at, now()), insights_synced_at
FROM meta_ad_connections
WHERE status IN ('active','token_invalid') AND ad_account_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Insights: ad set rows, the ad account, and more results.
ALTER TABLE meta_ad_insights
  ADD COLUMN ad_account_id text CHECK (ad_account_id ~ '^\d{1,32}$'),
  ADD COLUMN adset_id text CHECK (adset_id ~ '^\d{1,32}$'),
  ADD COLUMN link_clicks bigint NOT NULL DEFAULT 0 CHECK (link_clicks >= 0),
  ADD COLUMN leads bigint NOT NULL DEFAULT 0 CHECK (leads >= 0),
  ADD COLUMN purchases bigint NOT NULL DEFAULT 0 CHECK (purchases >= 0);
ALTER TABLE meta_ad_insights DROP CONSTRAINT IF EXISTS meta_ad_insights_level_check; -- additive-exception: replaced by the same check that also allows 'adset' (a superset)
ALTER TABLE meta_ad_insights ADD CONSTRAINT meta_ad_insights_level_check CHECK (level IN ('campaign','adset','ad')) NOT VALID;
UPDATE meta_ad_insights i SET ad_account_id = c.ad_account_id
FROM meta_ad_connections c WHERE c.account_id = i.account_id AND c.id = i.connection_id AND i.ad_account_id IS NULL;
ALTER TABLE meta_ad_insights VALIDATE CONSTRAINT meta_ad_insights_level_check;

-- Objects: their ad account, ad set delivery and the ad's creative.
ALTER TABLE meta_ad_objects
  ADD COLUMN ad_account_id text CHECK (ad_account_id ~ '^\d{1,32}$'),
  ADD COLUMN destination_type text CHECK (char_length(destination_type) <= 64),
  ADD COLUMN optimization_goal text CHECK (char_length(optimization_goal) <= 64),
  ADD COLUMN thumbnail_url text CHECK (char_length(thumbnail_url) <= 2048 AND thumbnail_url ~ '^https://'),
  ADD COLUMN image_url text CHECK (char_length(image_url) <= 2048 AND image_url ~ '^https://'),
  ADD COLUMN creative_title text CHECK (char_length(creative_title) <= 500),
  ADD COLUMN creative_body text CHECK (char_length(creative_body) <= 4000),
  ADD COLUMN cta_type text CHECK (char_length(cta_type) <= 64);
UPDATE meta_ad_objects o SET ad_account_id = c.ad_account_id
FROM meta_ad_connections c WHERE c.account_id = o.account_id AND c.id = o.connection_id AND o.ad_account_id IS NULL;

CREATE TABLE meta_ad_insight_platforms (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^\d{1,32}$'),
  campaign_id text NOT NULL CHECK (campaign_id ~ '^\d{1,32}$'),
  day date NOT NULL,
  platform text NOT NULL CHECK (platform IN ('facebook','instagram','messenger','audience_network','whatsapp','threads','unknown')),
  spend numeric(14,2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  link_clicks bigint NOT NULL DEFAULT 0 CHECK (link_clicks >= 0),
  conversations_started bigint NOT NULL DEFAULT 0 CHECK (conversations_started >= 0),
  leads bigint NOT NULL DEFAULT 0 CHECK (leads >= 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campaign_id, day, platform),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);
CREATE INDEX meta_ad_insight_platforms_day ON meta_ad_insight_platforms(account_id, day);

ALTER TABLE meta_ad_insight_platforms ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_insight_platforms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_insight_platforms FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_insight_platforms FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_insight_platforms TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_insight_platforms TO bodhinox_worker;

CREATE TABLE meta_ad_reach (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  ad_account_id text NOT NULL CHECK (ad_account_id ~ '^\d{1,32}$'),
  -- 'account' rows carry the ad account id as object_id.
  level text NOT NULL CHECK (level IN ('account','campaign','adset','ad')),
  object_id text NOT NULL CHECK (object_id ~ '^\d{1,32}$'),
  preset text NOT NULL CHECK (preset IN ('last_7d','last_30d','last_90d')),
  reach bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  frequency numeric(10,4) NOT NULL DEFAULT 0 CHECK (frequency >= 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, level, object_id, preset),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);

ALTER TABLE meta_ad_reach ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_reach FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_reach FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_reach FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_reach TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_reach TO bodhinox_worker;
