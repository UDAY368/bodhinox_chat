-- Phase 13: business insights computed from fixed reporting queries (never
-- free-form SQL). A member requests a run (queued, no data); the worker fills
-- the numbers, caveats and narrative. Requesters see their own runs, admins
-- see all. requested_by is audit identity (no foreign key); the worker
-- rechecks the requester's live membership and role before running.
-- Additive: a new, empty table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_insight_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  insight_key text NOT NULL CHECK (insight_key IN ('conversation_volume','response_times','agent_workload','campaign_funnel',
    'flow_outcomes','template_delivery','ai_performance','commerce_sales')),
  range_from date NOT NULL,
  range_to date NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','skipped','failed')),
  data jsonb CHECK (data IS NULL OR (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 65536)),
  coverage jsonb CHECK (coverage IS NULL OR (jsonb_typeof(coverage) = 'object' AND pg_column_size(coverage) <= 8192)),
  caveats text[] NOT NULL DEFAULT '{}' CHECK (cardinality(caveats) <= 16),
  uncertainty text CHECK (uncertainty IN ('low','medium','high')),
  narrative text CHECK (char_length(narrative) <= 2000),
  narrative_source text CHECK (narrative_source IN ('model','template')),
  guard_flags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(guard_flags) <= 16),
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_links) = 'array' AND pg_column_size(source_links) <= 4096),
  error_code text CHECK (char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, id),
  CHECK (range_to >= range_from AND range_to - range_from <= 366)
);
CREATE INDEX ai_insight_runs_account_created_idx ON ai_insight_runs (account_id, created_at DESC);
-- The cross-workspace retention due check (crm_accounts_with_ai_retention_due) probes by age.
CREATE INDEX ai_insight_runs_created_idx ON ai_insight_runs (created_at);

ALTER TABLE ai_insight_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insight_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY read_own_or_admin ON ai_insight_runs FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent')
    AND (requested_by = app_user_id() OR app_write_allowed('admin')));
CREATE POLICY app_request ON ai_insight_runs FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND requested_by = app_user_id()
    AND status = 'queued' AND data IS NULL AND narrative IS NULL);
CREATE POLICY worker_all ON ai_insight_runs FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON ai_insight_runs TO bodhinox_app;
GRANT INSERT (account_id, requested_by, insight_key, range_from, range_to) ON ai_insight_runs TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_insight_runs TO bodhinox_worker;
