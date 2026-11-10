-- A new workspace never starts on the unrestricted plan by default (audit
-- finding 41).
--
-- billing_assign_initial_plan(p_account, p_plan) now accepts p_plan NULL,
-- meaning the lowest plan in the catalogue (smallest sort; 'free' wins a tie), which is
-- 'free' in the seeded catalogue. The application passes NULL when
-- NEW_WORKSPACE_PLAN is unset. Everything else is unchanged: it inserts only
-- when the workspace has no subscription row and was created in the last
-- hour, so an existing workspace is never touched, and workspaces without a
-- subscription row keep resolving to 'enterprise' exactly as before. Same
-- signature, owner and grants.
-- Additive.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION billing_assign_initial_plan(p_account uuid, p_plan text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE version_id uuid; chosen text; inserted integer;
BEGIN
  chosen := COALESCE(p_plan, (SELECT p.id FROM plans p ORDER BY p.sort, p.id <> 'free', p.id LIMIT 1));
  SELECT v.id INTO version_id FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.version = p.current_version
    WHERE p.id = chosen;
  IF version_id IS NULL THEN RAISE EXCEPTION 'unknown_plan' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p_account AND a.created_at > now() - interval '1 hour') THEN
    RETURN false;
  END IF;
  INSERT INTO account_subscriptions(account_id, plan_id, status, plan_version_id)
    VALUES (p_account, chosen, 'active', version_id)
    ON CONFLICT (account_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END $$;
REVOKE ALL ON FUNCTION billing_assign_initial_plan(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_assign_initial_plan(uuid, text) TO bodhinox_auth;
