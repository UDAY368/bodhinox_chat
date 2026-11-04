-- Phase 13: retention for AI assistant data. The worker's daily scheduler
-- reads which workspaces have something due through one fixed definer
-- function (no tenant context exists yet at that point), then sweeps each
-- workspace in its own tenant-scoped job. The rules (src/lib/ai/retention.ts):
--   ai_suggestions   output/citations cleared after 30 days, row deleted after 180
--   ai_assessments   superseded rows deleted after 30 days, every row after 180
--   ai_insight_runs  deleted after 90 days
--   ai_usage_log     deleted after 400 days
-- The definer runs as the migration owner, which FORCE RLS also binds, so it
-- gets owner-only SELECT policies (same pattern as
-- crm_accounts_with_due_report_schedules). Additive.
--
-- Every branch is an index range probe on a created_at/superseded_at index
-- (ai_usage_log_created_idx is built CONCURRENTLY by
-- 20261111101000_ai_usage_log_created_index, the others with their tables),
-- so nothing is scanned while no row is due.
SET LOCAL lock_timeout = '5s';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_suggestions','ai_assessments','ai_insight_runs','ai_usage_log'] LOOP
    EXECUTE format('CREATE POLICY ai_retention_owner ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;

CREATE FUNCTION crm_accounts_with_ai_retention_due() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT due.account_id FROM (
    SELECT s.account_id FROM ai_suggestions s
      WHERE s.created_at < now() - interval '30 days'
        AND (s.created_at < now() - interval '180 days' OR s.output <> '{}'::jsonb OR s.citations <> '[]'::jsonb)
    UNION ALL
    SELECT a.account_id FROM ai_assessments a WHERE a.created_at < now() - interval '180 days'
    UNION ALL
    SELECT a.account_id FROM ai_assessments a
      WHERE a.superseded_at IS NOT NULL AND a.superseded_at < now() - interval '30 days'
    UNION ALL
    SELECT r.account_id FROM ai_insight_runs r WHERE r.created_at < now() - interval '90 days'
    UNION ALL
    SELECT u.account_id FROM ai_usage_log u WHERE u.created_at < now() - interval '400 days'
  ) due
  LIMIT 1000
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_ai_retention_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_ai_retention_due() TO bodhinox_worker;
