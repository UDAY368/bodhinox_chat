-- Phase 14: workspace export, account deletion and terms acceptance, and the
-- optional default plan for new workspaces.
--
-- workspace_exports: one row per requested export; the row and its
-- workspace.export job are committed together. One queued/running export per
-- workspace. The file lives in private storage under <account_id>/exports/ and
-- is expired (status 'expired', object removed) after 7 days by the job's own
-- sweep; the row is kept.
--
-- auth_users gains nullable deleted_at (account deletion anonymises the row;
-- user_id stays the audit identity), terms_version and terms_accepted_at
-- (stored only when TERMS_VERSION is configured).
--
-- billing_assign_initial_plan lets the identity role give a brand-new
-- workspace the NEW_WORKSPACE_PLAN (when that env var is set) without any
-- table grant: it inserts only when the workspace has no subscription row and
-- was created in the last hour, so it can never change an existing workspace.
--
-- auth_prepare_account_deletion lets the identity role close the deleting
-- user's sole-member workspaces (deletion request, 30-day grace, no purge) and
-- revoke their API keys, which are tenant rows it cannot otherwise reach.
-- Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE workspace_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  storage_key text CHECK (char_length(storage_key) BETWEEN 1 AND 512),
  size_bytes bigint CHECK (size_bytes >= 0),
  expires_at timestamptz,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, id),
  CHECK (status <> 'ready' OR (storage_key IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX workspace_exports_one_running ON workspace_exports(account_id) WHERE status IN ('queued','running');
CREATE INDEX workspace_exports_account_idx ON workspace_exports(account_id, created_at DESC);
CREATE INDEX workspace_exports_expiry_idx ON workspace_exports(expires_at) WHERE status = 'ready';
ALTER TABLE workspace_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON workspace_exports FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY admin_insert ON workspace_exports FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'queued' AND requested_by = app_user_id());
CREATE POLICY worker_all ON workspace_exports FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON workspace_exports TO bodhinox_app;
GRANT INSERT (account_id, requested_by, status) ON workspace_exports TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON workspace_exports TO bodhinox_worker;
-- The expiry sweep finds workspaces with ready exports past their window.
CREATE FUNCTION crm_accounts_with_exports_due() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT e.account_id FROM workspace_exports e
  WHERE (e.status = 'ready' AND e.expires_at <= now())
     OR (e.status IN ('queued','running') AND e.created_at < now() - interval '1 day')
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_exports_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_exports_due() TO bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY exports_owner ON workspace_exports FOR SELECT TO %I USING (true)', current_user);
END $$;

-- Metadata-only column adds (no defaults).
ALTER TABLE auth_users ADD COLUMN deleted_at timestamptz;
ALTER TABLE auth_users ADD COLUMN terms_version text CHECK (char_length(terms_version) BETWEEN 1 AND 40);
ALTER TABLE auth_users ADD COLUMN terms_accepted_at timestamptz;

-- ---------------------------------------------------------------------------
CREATE FUNCTION billing_assign_initial_plan(p_account uuid, p_plan text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE version_id uuid; inserted integer;
BEGIN
  SELECT v.id INTO version_id FROM plans p JOIN plan_versions v ON v.plan_id = p.id AND v.version = p.current_version
    WHERE p.id = p_plan;
  IF version_id IS NULL THEN RAISE EXCEPTION 'unknown_plan' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p_account AND a.created_at > now() - interval '1 hour') THEN
    RETURN false;
  END IF;
  INSERT INTO account_subscriptions(account_id, plan_id, status, plan_version_id)
    VALUES (p_account, p_plan, 'active', version_id)
    ON CONFLICT (account_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END $$;
REVOKE ALL ON FUNCTION billing_assign_initial_plan(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_assign_initial_plan(uuid, text) TO bodhinox_auth;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY initial_plan_owner ON account_subscriptions FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;

-- Account deletion, identity-role side. Refuses (returns blocked=true) while
-- the user owns a workspace that has other members or an active provider
-- subscription not already cancelling: those need a transfer or a workspace
-- deletion request first. Otherwise each sole-member workspace the user owns
-- gets a deletion request (status 'closing', purge_after = now() + 30 days,
-- nothing deleted) and the user's API keys are revoked.
CREATE FUNCTION auth_prepare_account_deletion(p_user uuid)
RETURNS TABLE(blocked boolean, block_reason text, closed_workspaces integer, revoked_keys integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE closed integer := 0; revoked integer := 0; acct uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM account_memberships m WHERE m.user_id = p_user AND m.role = 'owner'
      AND EXISTS (SELECT 1 FROM account_memberships o WHERE o.account_id = m.account_id AND o.user_id <> p_user)) THEN
    RETURN QUERY SELECT true, 'owns_shared_workspace', 0, 0; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM account_memberships m JOIN account_subscriptions s ON s.account_id = m.account_id
      WHERE m.user_id = p_user AND m.role = 'owner' AND s.provider_subscription_id IS NOT NULL
        AND s.status NOT IN ('cancelled','suspended','incomplete') AND NOT s.cancel_at_period_end) THEN
    RETURN QUERY SELECT true, 'active_subscription', 0, 0; RETURN;
  END IF;
  FOR acct IN SELECT m.account_id FROM account_memberships m WHERE m.user_id = p_user AND m.role = 'owner' LOOP
    -- An admin-suspended workspace closes too and keeps its suspension as a hold
    -- (suspend fields and block_manual stay), so it is purge-due like any other.
    INSERT INTO account_lifecycle(account_id, status, deletion_requested_at, deletion_requested_by, purge_after)
      VALUES (acct, 'closing', now(), p_user, now() + interval '30 days')
      ON CONFLICT (account_id) DO UPDATE SET status = 'closing',
        deletion_requested_at = COALESCE(account_lifecycle.deletion_requested_at, now()),
        deletion_requested_by = COALESCE(account_lifecycle.deletion_requested_by, p_user),
        purge_after = COALESCE(account_lifecycle.purge_after, now() + interval '30 days');
    -- Nobody can join a workspace whose only owner is leaving: open invitations end now.
    UPDATE account_invitations SET expires_at = now() WHERE account_id = acct AND accepted_at IS NULL AND expires_at > now();
    INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES (acct, p_user, 'workspace.deletion_requested', acct::text, jsonb_build_object('via', 'account_deletion'));
    closed := closed + 1;
  END LOOP;
  UPDATE api_keys SET revoked_at = now() WHERE created_by = p_user AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked = ROW_COUNT;
  RETURN QUERY SELECT false, NULL::text, closed, revoked;
END $$;
REVOKE ALL ON FUNCTION auth_prepare_account_deletion(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_prepare_account_deletion(uuid) TO bodhinox_auth;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY account_deletion_owner ON api_keys FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY account_deletion_owner ON account_invitations FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Invitation redemption (identity role) refuses a workspace that is closing.
CREATE FUNCTION auth_workspace_closing(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.account_id = p_account AND l.status = 'closing')
$$;
REVOKE ALL ON FUNCTION auth_workspace_closing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_workspace_closing(uuid) TO bodhinox_auth;
