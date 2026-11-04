-- Phase 13: per-workspace switches for the AI business assistant features.
-- One row per workspace; a missing row means every Phase 13 feature is off.
-- Turning a feature on never calls a provider by itself: the deployment kill
-- switch (AI_ENABLED) and a configured workspace key are still required.
-- Admin-only writes; every member (and the worker) can read the switches.
-- Additive: a new, empty table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_workspace_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  summaries_enabled boolean NOT NULL DEFAULT false,
  suggestions_enabled boolean NOT NULL DEFAULT false,
  assessment_enabled boolean NOT NULL DEFAULT false,
  insights_enabled boolean NOT NULL DEFAULT false,
  -- Optional workspace cap on AI tokens per IST month (on top of the plan limit).
  monthly_token_cap bigint CHECK (monthly_token_cap IS NULL OR monthly_token_cap > 0),
  updated_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_workspace_settings FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON ai_workspace_settings FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin')
    AND (updated_by IS NULL OR updated_by = app_user_id()));
GRANT SELECT, INSERT, UPDATE ON ai_workspace_settings TO bodhinox_app;
GRANT SELECT ON ai_workspace_settings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_workspace_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
