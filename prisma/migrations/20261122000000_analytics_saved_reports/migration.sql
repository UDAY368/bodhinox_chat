-- Analytics redesign: saved report definitions (Analytics > Reports).
--
-- An admin or owner saves a named report: which conversation metrics, grouped
-- by day, week, channel, agent or label, for one channel or all, over a range
-- preset or fixed custom days, as CSV or PDF. The app previews and exports it
-- on demand (src/lib/analytics/saved-reports.ts, every query in withTenant)
-- and can email it on a schedule: a report_schedules row with kind
-- 'saved_report' names the definition (saved_report_id) and a local minute as
-- well as the hour. The worker snapshots the definition into the report_runs
-- params when it queues a scheduled run, so a later edit never changes a file
-- already being built. Deleting a definition deletes its schedule (runs keep
-- their file until they expire, schedule_id set NULL as before).
--
-- Additive: a new FORCE RLS table (admins and owners read and write, the worker
-- reads), two new report_schedules columns, and the report_runs and
-- report_schedules kind checks widened to allow 'saved_report'. The widened
-- checks and the new constraints are NOT VALID here and validated in
-- 20261122000100; the one-schedule-per-report index is built CONCURRENTLY in
-- 20261122000200.
SET LOCAL lock_timeout = '5s';

CREATE TABLE analytics_saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND name = btrim(name)),
  metrics text[] NOT NULL CHECK (cardinality(metrics) BETWEEN 1 AND 6 AND array_position(metrics, NULL) IS NULL
    AND metrics <@ ARRAY['new','resolved','first_response','resolution','messages','failed']::text[]),
  group_by text NOT NULL CHECK (group_by IN ('day','week','channel','agent','label')),
  channel text NOT NULL DEFAULT 'all' CHECK (channel IN ('all','whatsapp','instagram')),
  range_preset text NOT NULL CHECK (range_preset IN ('today','7d','30d','90d','this_week','last_week','this_month','last_month','custom')),
  from_day date,
  to_day date,
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','pdf')),
  -- Audit identity only (no foreign key).
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((range_preset = 'custom') = (from_day IS NOT NULL AND to_day IS NOT NULL)),
  CHECK (from_day IS NULL OR to_day IS NULL OR (from_day <= to_day AND to_day - from_day < 366))
);
CREATE UNIQUE INDEX analytics_saved_reports_name_idx ON analytics_saved_reports (account_id, lower(name));
CREATE INDEX analytics_saved_reports_account_idx ON analytics_saved_reports (account_id, created_at DESC);

ALTER TABLE analytics_saved_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_saved_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON analytics_saved_reports FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_read ON analytics_saved_reports FOR SELECT TO bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON analytics_saved_reports FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_saved_reports TO bodhinox_app;
GRANT SELECT ON analytics_saved_reports TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON analytics_saved_reports
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE report_runs DROP CONSTRAINT report_runs_kind_check; -- additive-exception: widened below to also allow 'saved_report'
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check
  CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily','saved_report')) NOT VALID;

ALTER TABLE report_schedules DROP CONSTRAINT report_schedules_kind_check; -- additive-exception: widened below to also allow 'saved_report'
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_kind_check
  CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily','saved_report')) NOT VALID;

ALTER TABLE report_schedules ADD COLUMN saved_report_id uuid;
-- Local minute past hour_local (the hour stays in hour_local).
ALTER TABLE report_schedules ADD COLUMN minute_local smallint NOT NULL DEFAULT 0;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_minute_local_check
  CHECK (minute_local BETWEEN 0 AND 59) NOT VALID;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_saved_report_check
  CHECK ((kind = 'saved_report') = (saved_report_id IS NOT NULL)) NOT VALID;
ALTER TABLE report_schedules ADD CONSTRAINT report_schedules_saved_report_fkey
  FOREIGN KEY (account_id, saved_report_id) REFERENCES analytics_saved_reports(account_id, id) ON DELETE CASCADE NOT VALID;

GRANT INSERT (saved_report_id, minute_local) ON report_schedules TO bodhinox_app;
GRANT UPDATE (minute_local) ON report_schedules TO bodhinox_app;
