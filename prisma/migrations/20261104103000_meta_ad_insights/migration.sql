-- Phase 10: daily campaign- and ad-level insights from the Marketing API. The
-- worker upserts a rolling 30-day window; members read it through the Ads
-- routes only. Nothing here runs unless META_ADS_ENABLED and its config are set.
-- Additive.

CREATE TABLE meta_ad_insights (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('campaign','ad')),
  object_id text NOT NULL CHECK (object_id ~ '^\d{1,32}$'),
  campaign_id text CHECK (campaign_id ~ '^\d{1,32}$'),
  name text CHECK (char_length(name) <= 500),
  status text CHECK (char_length(status) <= 64),
  objective text CHECK (char_length(objective) <= 64),
  day date NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  conversations_started bigint NOT NULL DEFAULT 0 CHECK (conversations_started >= 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, level, object_id, day),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);
CREATE INDEX meta_ad_insights_day ON meta_ad_insights(account_id, day);

ALTER TABLE meta_ad_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_insights FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_insights FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_insights FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_insights TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_insights TO bodhinox_worker;
