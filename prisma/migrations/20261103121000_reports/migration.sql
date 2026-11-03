-- Phase 9: downloadable analytics reports. Additive.
--
-- A member (admin or owner) requests a report; the row and its
-- 'analytics.report' job are written in one transaction before the request is
-- acknowledged. The worker builds the CSV (counts and durations only, never
-- message content), stores it as a private object under
-- <account_id>/reports/<id>.csv and marks the row ready. Files are downloaded
-- only through the authorised, audit-logged download route. Reports expire 30
-- days after the request: the sweep deletes the file and marks the row expired
-- (the row stays as a record that the report existed).
--
-- Roles: admins and owners read their workspace's rows. The app role may only
-- insert a queued request for itself (column grants plus the policy below);
-- every later change is made by the worker.
CREATE TABLE report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance')),
  -- The resolved range ({from, to} local days, timezone); never free text.
  params jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2048),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  requested_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  email_requested boolean NOT NULL DEFAULT false,
  object_key text CHECK (object_key IS NULL OR object_key ~ '^[0-9a-f-]{36}/reports/[0-9a-f-]{36}\.csv$'),
  row_count integer CHECK (row_count >= 0),
  truncated boolean NOT NULL DEFAULT false,
  byte_size bigint CHECK (byte_size >= 0),
  -- A sanitized category (e.g. 'timed_out', 'build_failed'); never provider text.
  error text CHECK (char_length(error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  UNIQUE (account_id, id)
);
-- Empty new table: plain indexes are safe here.
CREATE INDEX report_runs_account_created_idx ON report_runs (account_id, created_at DESC);
CREATE INDEX report_runs_due_idx ON report_runs (expires_at) WHERE status <> 'expired';

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON report_runs FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY app_request ON report_runs FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND requested_by = app_user_id()
    AND status = 'queued' AND object_key IS NULL AND row_count IS NULL AND error IS NULL AND finished_at IS NULL);
CREATE POLICY worker_write ON report_runs FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON report_runs TO bodhinox_app, bodhinox_worker;
GRANT INSERT (account_id, kind, params, requested_by, email_requested) ON report_runs TO bodhinox_app;
GRANT INSERT, UPDATE, DELETE ON report_runs TO bodhinox_worker;

-- Workspaces with a report to expire, or a request stuck past six hours (its
-- job exhausted its attempts). Fixed definer read for the worker's scheduler.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY reports_migration_owner ON report_runs FOR SELECT TO %I USING (true)', current_user);
END $$;
CREATE FUNCTION crm_accounts_with_due_reports() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT r.account_id FROM report_runs r
  WHERE r.status <> 'expired' AND (r.expires_at < now()
    OR (r.status IN ('queued','running') AND r.created_at < now() - interval '6 hours'))
  LIMIT 1000
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_due_reports() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_due_reports() TO bodhinox_worker;
