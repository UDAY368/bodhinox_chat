-- Ads phases 3-5: cost caps and "replace this ad" on drafts, click-to-Messenger
-- ads, ads from another of the admin's Facebook Pages (drafts already carry
-- page_id), saved ad templates, deal-stage conversion events, and engagement
-- and website-visitor audiences. Additive except for widened CHECKs.
SET LOCAL lock_timeout = '5s';

-- Drafts: a cost cap per result, and the ad a new version replaces (paused once the new one exists).
ALTER TABLE meta_ad_drafts ADD COLUMN bid_cap_minor bigint;
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_bid_cap_check CHECK (bid_cap_minor IS NULL OR bid_cap_minor > 0) NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_bid_cap_check;
ALTER TABLE meta_ad_drafts ADD COLUMN replaces_ad_id text;
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_replaces_check CHECK (replaces_ad_id IS NULL OR replaces_ad_id ~ '^\d{1,32}$') NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_replaces_check;
ALTER TABLE meta_ad_drafts DROP CONSTRAINT meta_ad_drafts_kind_check; -- additive-exception: widened below to also allow 'messenger'
ALTER TABLE meta_ad_drafts ADD CONSTRAINT meta_ad_drafts_kind_check
  CHECK (kind IN ('whatsapp','instagram_direct','lead_form','website','messenger')) NOT VALID;
ALTER TABLE meta_ad_drafts VALIDATE CONSTRAINT meta_ad_drafts_kind_check;

-- Saved ad setups (admins write through the worker role; members read).
CREATE TABLE meta_ad_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 16384),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX meta_ad_templates_name ON meta_ad_templates(account_id, lower(name));
ALTER TABLE meta_ad_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_templates FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_templates FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_templates TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_templates TO bodhinox_worker;

-- Deal stages as conversion events (Lead when a deal is opened, Purchase when it is won), off by default.
ALTER TABLE meta_ad_connections ADD COLUMN capi_deal_events boolean NOT NULL DEFAULT false;
GRANT SELECT (capi_deal_events), UPDATE (capi_deal_events) ON meta_ad_connections TO bodhinox_app;
ALTER TABLE capi_events DROP CONSTRAINT capi_events_source_check; -- additive-exception: widened below to also allow 'deal'
ALTER TABLE capi_events ADD CONSTRAINT capi_events_source_check
  CHECK (source IN ('payment_link','order','form','flow','deal')) NOT VALID;
ALTER TABLE capi_events VALIDATE CONSTRAINT capi_events_source_check;

-- Engagement (Facebook Page or Instagram account) and website-visitor (pixel) audiences.
ALTER TABLE meta_audiences DROP CONSTRAINT meta_audiences_kind_check; -- additive-exception: widened below to also allow rule audiences
ALTER TABLE meta_audiences ADD CONSTRAINT meta_audiences_kind_check
  CHECK (kind IN ('customer_list','lookalike','engagement','website')) NOT VALID;
ALTER TABLE meta_audiences VALIDATE CONSTRAINT meta_audiences_kind_check;
ALTER TABLE meta_audiences ADD COLUMN rule_source text;
ALTER TABLE meta_audiences ADD CONSTRAINT meta_audiences_rule_source_check
  CHECK (rule_source IS NULL OR rule_source ~ '^(page|instagram|pixel):\d{1,32}$') NOT VALID;
ALTER TABLE meta_audiences VALIDATE CONSTRAINT meta_audiences_rule_source_check;
ALTER TABLE meta_audiences ADD COLUMN retention_days int;
ALTER TABLE meta_audiences ADD CONSTRAINT meta_audiences_retention_check
  CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 365) NOT VALID;
ALTER TABLE meta_audiences VALIDATE CONSTRAINT meta_audiences_retention_check;
ALTER TABLE meta_audiences ADD CONSTRAINT meta_audiences_rule_check CHECK (
  (kind NOT IN ('engagement','website') AND rule_source IS NULL AND retention_days IS NULL)
  OR (kind = 'engagement' AND rule_source ~ '^(page|instagram):' AND retention_days IS NOT NULL AND segment_id IS NULL AND origin_id IS NULL)
  OR (kind = 'website' AND rule_source ~ '^pixel:' AND retention_days IS NOT NULL AND segment_id IS NULL AND origin_id IS NULL)) NOT VALID;
ALTER TABLE meta_audiences VALIDATE CONSTRAINT meta_audiences_rule_check;
