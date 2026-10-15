-- The migration owner may read only the tables needed by fixed definer routing.
-- Runtime roles receive no unscoped CRM grants or RLS bypass.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['automations','flows','flow_runs','automation_pending_executions']
  LOOP
    EXECUTE format('CREATE POLICY scheduling_migration_owner ON %I FOR SELECT TO %I USING (true)',t,current_user);
  END LOOP;
END $$;

CREATE FUNCTION crm_accounts_for_scheduling() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.account_id FROM automations a WHERE a.is_active
  UNION
  SELECT f.account_id FROM flows f WHERE f.status='active'
  UNION
  SELECT r.account_id FROM flow_runs r WHERE r.status='active'
  UNION
  SELECT p.account_id FROM automation_pending_executions p WHERE p.status IN ('pending','running','awaiting_reply')
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_scheduling() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_scheduling() TO bodhinox_worker;
