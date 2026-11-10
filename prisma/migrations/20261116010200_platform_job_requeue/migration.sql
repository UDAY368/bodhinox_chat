-- Audit 38: platform operators see recent failed jobs and requeue one from the Health console
-- instead of running SQL by hand. Both functions are SECURITY DEFINER with a pinned search_path and
-- EXECUTE for bodhinox_platform only. They return ids, types, counts and workspace names: never a
-- payload or an error text. A job whose provider outcome is uncertain is refused: it needs
-- reconciliation, not a blind re-run. A requeue is audited (platform_audit_log and the workspace's
-- audit_logs). New functions only: additive.
SET LOCAL lock_timeout = '5s';

-- Failed jobs of the last 7 days, newest first (served by jobs_failed_updated_idx).
CREATE FUNCTION crm_platform_failed_jobs(p_limit integer)
RETURNS TABLE(id uuid, type text, account_id uuid, account_name text, attempts integer, max_attempts integer,
  needs_reconciliation boolean, failed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT j.id, j.type, j.tenant_id, a.name, j.attempts, j.max_attempts,
    COALESCE(j.last_error = 'Provider send outcome requires reconciliation', false), j.updated_at
  FROM jobs j LEFT JOIN accounts a ON a.id = j.tenant_id
  WHERE j.status = 'failed' AND j.updated_at > now() - interval '7 days'
  ORDER BY j.updated_at DESC, j.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;
REVOKE ALL ON FUNCTION crm_platform_failed_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_failed_jobs(integer) TO bodhinox_platform;

-- Requeues one failed job with a fresh attempt budget, to run now. Returns 'requeued',
-- 'not_found', 'not_failed' (pending, running or done: nothing to do) or 'needs_reconciliation'.
CREATE FUNCTION crm_platform_requeue_job(p_job uuid, p_admin_email text, p_reason text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;
  SELECT * INTO target FROM jobs WHERE jobs.id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target.status <> 'failed' THEN RETURN 'not_failed'; END IF;
  IF target.last_error = 'Provider send outcome requires reconciliation' THEN RETURN 'needs_reconciliation'; END IF;
  UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), lease_until = NULL, lease_token = NULL,
    last_error = NULL, updated_at = now()
  WHERE jobs.id = p_job AND jobs.status = 'failed';
  PERFORM crm_platform_audit(p_admin_email, 'job.requeue', target.tenant_id, p_job::text, trim(p_reason),
    jsonb_build_object('type', target.type, 'attempts', target.attempts));
  RETURN 'requeued';
END $$;
REVOKE ALL ON FUNCTION crm_platform_requeue_job(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_requeue_job(uuid, text, text) TO bodhinox_platform;
