-- Phase 12: report kinds, PDF format, scheduled delivery and
-- permission-controlled sharing. Additive.
--
-- Schedules: an admin schedules a report kind with a cadence and up to ten
-- admin recipients. The worker rechecks the creator's and every recipient's
-- live membership and role at run time and at send time; a creator who lost
-- admin access pauses the schedule ('creator_lost_access'). One scheduled run
-- per (schedule, period) through report_runs_schedule_period.
--
-- Shares: a share carries no token. It opens only through
-- crm_open_report_share(), which requires the share's workspace to be the
-- live session's workspace (app_account_id()), the session's live role to be
-- at least min_role (app_write_allowed reads app.account_role, which
-- withTenant sets from the live session), and the share and its report to be
-- unexpired and unrevoked. Every open is counted here and audited by the route.
SET LOCAL lock_timeout = '5s';

-- ================================================================ report_runs
ALTER TABLE report_runs DROP CONSTRAINT report_runs_kind_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_kind_check
  CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily'));
ALTER TABLE report_runs ADD COLUMN format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','pdf'));
ALTER TABLE report_runs DROP CONSTRAINT report_runs_object_key_check;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_object_key_check
  CHECK (object_key IS NULL OR (object_key ~ '^[0-9a-f-]{36}/reports/[0-9a-f-]{36}\.(csv|pdf)$'
    AND right(object_key, length(format) + 1) = '.' || format));
GRANT INSERT (format) ON report_runs TO bodhinox_app;

-- ================================================================ report_schedules
CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('campaign_daily','campaign_summary','member_campaigns','agent_performance',
    'product_summary','service_summary','commerce_daily')),
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','pdf')),
  cadence text NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  -- Local hour in the workspace timezone.
  hour_local smallint NOT NULL DEFAULT 8 CHECK (hour_local BETWEEN 0 AND 23),
  -- auth_users ids; each must be an admin or owner of this workspace when the report is sent.
  recipients uuid[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 10 AND array_position(recipients, NULL) IS NULL),
  -- Audit identity only (no foreign key); rechecked against live membership at every run.
  created_by uuid NOT NULL,
  paused_at timestamptz,
  pause_reason text CHECK (pause_reason IN ('manual','creator_lost_access','no_recipients')),
  next_run_at timestamptz NOT NULL,
  last_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((paused_at IS NULL) = (pause_reason IS NULL)),
  FOREIGN KEY (account_id, last_run_id) REFERENCES report_runs(account_id, id) ON DELETE SET NULL (last_run_id)
);
-- Empty new table: plain indexes are safe here.
CREATE INDEX report_schedules_account_idx ON report_schedules (account_id, created_at);
CREATE INDEX report_schedules_due_idx ON report_schedules (next_run_at) WHERE paused_at IS NULL;

ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON report_schedules FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY app_insert ON report_schedules FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND created_by = app_user_id()
    AND last_run_id IS NULL);
CREATE POLICY app_update ON report_schedules FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY app_delete ON report_schedules FOR DELETE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON report_schedules FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, DELETE ON report_schedules TO bodhinox_app;
GRANT INSERT (id, account_id, kind, format, cadence, hour_local, recipients, created_by, paused_at, pause_reason,
  next_run_at, created_at, updated_at) ON report_schedules TO bodhinox_app;
GRANT UPDATE (recipients, hour_local, cadence, format, paused_at, pause_reason, next_run_at, updated_at)
  ON report_schedules TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedules TO bodhinox_worker;

-- The run a schedule produced. Only the worker sets it (no app column grant).
ALTER TABLE report_runs ADD COLUMN schedule_id uuid;
ALTER TABLE report_runs ADD CONSTRAINT report_runs_schedule_fkey
  FOREIGN KEY (account_id, schedule_id) REFERENCES report_schedules(account_id, id) ON DELETE SET NULL (schedule_id);
-- One run per schedule and period; a repeated sweep is a no-op (ON CONFLICT DO NOTHING).
-- The period is (from, to): after a cadence change a daily and a weekly or
-- monthly period can start on the same day but never end on the same day,
-- so the new cadence's first report is not dropped as a repeat.
-- report_runs is small: a plain index is fine.
CREATE UNIQUE INDEX report_runs_schedule_period ON report_runs (account_id, schedule_id, (params->>'from'), (params->>'to'))
  WHERE schedule_id IS NOT NULL;

-- Workspaces with a schedule due. Fixed definer read for the worker's scheduler.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY report_schedules_owner ON report_schedules FOR SELECT TO %I USING (true)', current_user);
END $$;
CREATE FUNCTION crm_accounts_with_due_report_schedules() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT s.account_id FROM report_schedules s
  WHERE s.paused_at IS NULL AND s.next_run_at <= now()
  LIMIT 1000
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_due_report_schedules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_due_report_schedules() TO bodhinox_worker;

-- ================================================================ report_shares
CREATE TABLE report_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  report_run_id uuid NOT NULL,
  min_role text NOT NULL CHECK (min_role IN ('viewer','agent','admin')),
  created_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  open_count integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  last_opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  FOREIGN KEY (account_id, report_run_id) REFERENCES report_runs(account_id, id) ON DELETE CASCADE
);
CREATE INDEX report_shares_run_idx ON report_shares (account_id, report_run_id);

ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON report_shares FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY app_create ON report_shares FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND created_by = app_user_id());
CREATE POLICY app_revoke ON report_shares FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON report_shares TO bodhinox_app;
-- created_at, open_count and revoked_at are server-controlled on insert, so the 7-day bound cannot be forged.
GRANT INSERT (account_id, report_run_id, min_role, created_by, expires_at) ON report_shares TO bodhinox_app;
GRANT UPDATE (revoked_at) ON report_shares TO bodhinox_app;

-- The definer below runs as the owner, which FORCE RLS also binds; it reads
-- report_runs through reports_migration_owner (20261103121000_reports).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY report_shares_owner_read ON report_shares FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY report_shares_owner_open ON report_shares FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Opens a share for the live session: same workspace, live role >= min_role,
-- unrevoked and unexpired share of a ready, unexpired report. Counts the open.
-- Returns no row for anything else (the route answers a uniform 404).
CREATE FUNCTION crm_open_report_share(p_share uuid)
RETURNS TABLE(run_id uuid, object_key text, kind text, format text, params jsonb)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE report_shares s SET open_count = s.open_count + 1, last_opened_at = now()
  FROM report_runs r
  WHERE s.id = p_share
    AND s.account_id = app_account_id()
    AND app_write_allowed(s.min_role)
    AND s.revoked_at IS NULL AND s.expires_at > now()
    AND r.account_id = s.account_id AND r.id = s.report_run_id
    AND r.status = 'ready' AND r.expires_at > now() AND r.object_key IS NOT NULL
  RETURNING r.id, r.object_key, r.kind, r.format, r.params
$$;
REVOKE ALL ON FUNCTION crm_open_report_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_open_report_share(uuid) TO bodhinox_app;
