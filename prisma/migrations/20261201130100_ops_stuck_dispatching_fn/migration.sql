-- Batch 1: sends stuck in 'dispatching' for more than 10 minutes (the worker died or the
-- provider never answered) were seen by nobody. One count, read next to crm_ops_health()
-- by src/lib/ops/health.ts. A separate function keeps this additive: crm_ops_health()'s
-- result type is unchanged, so no DROP is needed. Count only: no ids or tenant data.
-- The owner SELECT policy on outbound_intents (20261113090200) already lets the
-- SECURITY DEFINER owner read across workspaces.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION crm_ops_stuck_dispatching()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT count(*) FROM outbound_intents i
  WHERE i.status = 'dispatching' AND i.updated_at < now() - interval '10 minutes'
$$;
REVOKE ALL ON FUNCTION crm_ops_stuck_dispatching() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_ops_stuck_dispatching() TO bodhinox_platform, bodhinox_worker;
