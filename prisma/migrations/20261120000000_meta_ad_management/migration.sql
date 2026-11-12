SET LOCAL lock_timeout = '5s';

-- Ad management, phase A: see campaigns, ad sets and ads, pause / resume them,
-- change budgets, end dates and names from Bodhinox. Additive:
--   * meta_ad_objects: a cache of the connected ad account's campaigns, ad sets
--     and ads, refreshed by the worker (meta.ad_objects_sync).
--   * meta_ad_changes: every change an admin asks for. A row and its
--     meta.ad_change job commit together; the worker applies it through an
--     outbound intent. An ambiguous outcome is settled by reading the object
--     back from Meta, never by sending again; if that is unclear too the row is
--     'unknown' until an admin re-checks or dismisses it.
--   * meta_ad_connections gains a workspace spending cap (max daily budget, in
--     the ad account currency's minor unit) and the objects sync time.
-- Nothing here calls Meta unless META_ADS_ENABLED (and, for changes,
-- META_ADS_MANAGE_ENABLED) is set.

ALTER TABLE meta_ad_connections
  ADD COLUMN max_daily_budget_minor bigint CHECK (max_daily_budget_minor > 0 AND max_daily_budget_minor < 1000000000000000),
  ADD COLUMN objects_synced_at timestamptz;
-- Members may read both (the app role's SELECT on this table is per column; tokens stay unreadable).
-- The cap is written only by the worker after the route's admin check.
GRANT SELECT (max_daily_budget_minor, objects_synced_at) ON meta_ad_connections TO bodhinox_app;

CREATE TABLE meta_ad_objects (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('campaign','adset','ad')),
  object_id text NOT NULL CHECK (object_id ~ '^\d{1,32}$'),
  campaign_id text CHECK (campaign_id ~ '^\d{1,32}$'),
  adset_id text CHECK (adset_id ~ '^\d{1,32}$'),
  name text CHECK (char_length(name) <= 500),
  -- What the advertiser set (ACTIVE, PAUSED, ARCHIVED, ...).
  status text CHECK (char_length(status) <= 64),
  -- What Meta is doing with it (ACTIVE, PAUSED, CAMPAIGN_PAUSED, IN_PROCESS, WITH_ISSUES, ...).
  effective_status text CHECK (char_length(effective_status) <= 64),
  objective text CHECK (char_length(objective) <= 64),
  -- Minor units of the ad account currency, as Meta stores them; null when the object has no budget of that kind.
  daily_budget_minor bigint CHECK (daily_budget_minor >= 0),
  lifetime_budget_minor bigint CHECK (lifetime_budget_minor >= 0),
  start_time timestamptz,
  end_time timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, object_id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id)
);
-- Empty new table: plain indexes are safe here.
CREATE INDEX meta_ad_objects_tree ON meta_ad_objects(account_id, level, campaign_id);

ALTER TABLE meta_ad_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_objects FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON meta_ad_objects FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_objects TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_ad_objects TO bodhinox_worker;

CREATE TABLE meta_ad_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('campaign','adset','ad')),
  object_id text NOT NULL CHECK (object_id ~ '^\d{1,32}$'),
  object_name text CHECK (char_length(object_name) <= 500),
  field text NOT NULL CHECK (field IN ('status','daily_budget','lifetime_budget','end_time','name')),
  from_value text CHECK (char_length(from_value) <= 500),
  to_value text NOT NULL CHECK (char_length(to_value) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','applied','failed','unknown','dismissed')),
  -- Meta code[:subcode] only, never a message body.
  last_error_code text CHECK (last_error_code ~ '^[0-9:]{0,32}$'),
  -- Historical audit identity of the admin who asked for the change.
  requested_by uuid NOT NULL,
  applied_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id),
  CHECK (status <> 'dismissed' OR resolved_by IS NOT NULL)
);
-- One open change per object and field: a second request waits for the first to settle.
CREATE UNIQUE INDEX meta_ad_changes_one_open ON meta_ad_changes(account_id, object_id, field)
  WHERE status IN ('queued','unknown');
CREATE INDEX meta_ad_changes_recent ON meta_ad_changes(account_id, created_at DESC);

ALTER TABLE meta_ad_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_changes FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Writes run as the worker after the route's admin, membership and CSRF checks
-- (like meta_ad_connections), so the app role only reads.
CREATE POLICY worker_write ON meta_ad_changes FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON meta_ad_changes TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON meta_ad_changes TO bodhinox_worker;
