-- Phase 12: crm_peek_report_share() lets the shared-report page show what a
-- share is and until when it can be opened, without counting an open.
-- It applies exactly the checks of crm_open_report_share() (share workspace
-- is the live session's workspace, live role at least min_role, share and
-- report unexpired and unrevoked, report ready) and returns no object key,
-- no params and nothing that identifies who shared it. Read-only (STABLE).
-- Additive: a new function only.
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION crm_peek_report_share(p_share uuid)
RETURNS TABLE(kind text, format text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.kind, r.format, LEAST(s.expires_at, r.expires_at)
  FROM report_shares s
  JOIN report_runs r ON r.account_id = s.account_id AND r.id = s.report_run_id
  WHERE s.id = p_share
    AND s.account_id = app_account_id()
    AND app_write_allowed(s.min_role)
    AND s.revoked_at IS NULL AND s.expires_at > now()
    AND r.status = 'ready' AND r.expires_at > now() AND r.object_key IS NOT NULL
$$;
REVOKE ALL ON FUNCTION crm_peek_report_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_peek_report_share(uuid) TO bodhinox_app;
