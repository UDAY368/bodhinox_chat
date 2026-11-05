-- Phase 15: one row of scalar operations signals for the token-protected deep
-- health check (src/lib/ops/health.ts, via the platform role) and the worker's
-- alert hook. Counts and ages only: no ids, tenant data, payloads or errors.
-- Additive: a new function only. A migration owner without superuser or BYPASSRLS
-- also needs owner SELECT policies on the forced-RLS queue tables; those are in
-- 20261113090200 and 20261113090300, one table per migration, so the
-- ACCESS EXCLUSIVE lock CREATE POLICY takes is never held on both hot tables at once.
-- The partial indexes the counts use are 20261113090400..20261113090600.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION crm_ops_health()
RETURNS TABLE(last_beat_age_s double precision, pending_due bigint, oldest_due_age_s double precision,
  expired_running_leases bigint, failed_jobs_1h bigint, unknown_intents bigint, unprocessed_webhooks_15m bigint,
  latest_migration text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    (SELECT extract(epoch FROM now() - max(h.beat_at))::double precision FROM worker_heartbeats h),
    (SELECT count(*) FROM jobs j WHERE j.status = 'pending' AND j.run_at <= now()),
    (SELECT extract(epoch FROM now() - min(j.run_at))::double precision FROM jobs j WHERE j.status = 'pending' AND j.run_at <= now()),
    (SELECT count(*) FROM jobs j WHERE j.status = 'running' AND j.lease_until < now()),
    (SELECT count(*) FROM jobs j WHERE j.status = 'failed' AND j.updated_at > now() - interval '1 hour'),
    (SELECT count(*) FROM outbound_intents i WHERE i.status = 'unknown'),
    (SELECT count(*) FROM webhook_receipts r
      WHERE r.status <> 'processed' AND r.created_at > now() - interval '24 hours' AND r.created_at < now() - interval '15 minutes'),
    (SELECT m.migration_name FROM _prisma_migrations m
      WHERE m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL ORDER BY m.finished_at DESC, m.migration_name DESC LIMIT 1)
$$;
REVOKE ALL ON FUNCTION crm_ops_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_ops_health() TO bodhinox_platform, bodhinox_worker;
