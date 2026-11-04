-- Phase 11: Instagram professional accounts connected through Instagram API with
-- Instagram Login (graph.instagram.com). The long-lived Instagram User token is
-- encrypted by the app (AES-GCM, src/lib/whatsapp/encryption.ts) and the app role
-- can never read it: members see only the non-secret columns through column
-- grants, and connect, disconnect, health and token refresh run as the worker
-- inside withTenant. Nothing here calls Meta; the feature stays off until
-- INSTAGRAM_ENABLED and its config are set (src/lib/instagram/config.ts). Additive.

CREATE TABLE instagram_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  -- The professional account id webhooks carry in entry[].id (from /me?fields=user_id).
  ig_user_id text NOT NULL CHECK (ig_user_id ~ '^\d{1,32}$'),
  username text CHECK (char_length(username) <= 64),
  name text CHECK (char_length(name) <= 500),
  -- encrypt() output (iv:ct:tag); NULL once cleared on disconnect.
  access_token_enc text CHECK (access_token_enc IS NULL OR char_length(access_token_enc) <= 8192),
  token_expires_at timestamptz,
  token_refreshed_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 50),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','token_invalid','permission_missing','disconnected')),
  webhook_subscribed_at timestamptz,
  last_webhook_at timestamptz,
  -- Meta code[:subcode] only, never a message body.
  last_error_code text CHECK (last_error_code ~ '^[0-9:]{0,32}$'),
  -- Webhook events of a type this phase does not process (shown as "unavailable" in settings).
  unsupported_event_count integer NOT NULL DEFAULT 0 CHECK (unsupported_event_count >= 0),
  unsupported_event_last_at timestamptz,
  -- Historical audit identity of the admin who connected it.
  connected_by_user_id uuid,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- Reconnecting the same Instagram account reuses its row.
  UNIQUE (account_id, ig_user_id),
  CHECK (status = 'disconnected' OR access_token_enc IS NOT NULL)
);
-- One live owner workspace per Instagram account; disconnect frees it.
CREATE UNIQUE INDEX instagram_accounts_live_ig_user ON instagram_accounts (ig_user_id) WHERE status <> 'disconnected';

ALTER TABLE instagram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instagram_accounts FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON instagram_accounts FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- The app role never reads a token: column grants only, and no writes.
GRANT SELECT (id, account_id, ig_user_id, username, name, token_expires_at, token_refreshed_at, scopes, status,
  webhook_subscribed_at, last_webhook_at, last_error_code, unsupported_event_count, unsupported_event_last_at,
  connected_by_user_id, connected_at, disconnected_at, created_at, updated_at)
  ON instagram_accounts TO bodhinox_app;
-- Rows are kept as 'disconnected' for history: no DELETE for either role.
GRANT SELECT, INSERT, UPDATE ON instagram_accounts TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- FORCE RLS applies to the definer too (same pattern as meta_ads_resolve_owner).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY instagram_resolve_owner ON instagram_accounts FOR SELECT TO %I USING (true)', current_user);
END $$;

-- Instagram webhook: entry[].id -> the workspace holding it. A token-invalid or
-- permission-missing account still resolves, so inbound messages are not lost
-- while staff reconnect.
CREATE FUNCTION crm_resolve_instagram_account(p_ig_user_id text)
RETURNS TABLE(account_id uuid, instagram_account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.account_id, a.id FROM instagram_accounts a
  WHERE p_ig_user_id ~ '^\d{1,32}$' AND a.ig_user_id = p_ig_user_id AND a.status <> 'disconnected'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crm_resolve_instagram_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_instagram_account(text) TO bodhinox_worker;

-- Connect-time cross-tenant check: which workspace holds this Instagram account?
CREATE FUNCTION crm_instagram_owner_account(p_ig_user_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.account_id FROM instagram_accounts a
  WHERE p_ig_user_id ~ '^\d{1,32}$' AND a.ig_user_id = p_ig_user_id AND a.status <> 'disconnected'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crm_instagram_owner_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_instagram_owner_account(text) TO bodhinox_worker;

-- Daily token sweep: workspaces with a live Instagram account. An unconnected
-- workspace is never listed, so it never gets an Instagram call.
CREATE FUNCTION crm_instagram_accounts_for_sweep()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT a.account_id FROM instagram_accounts a
  WHERE a.status <> 'disconnected'
  ORDER BY a.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_instagram_accounts_for_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_instagram_accounts_for_sweep() TO bodhinox_worker;

-- ================================================================ plans
-- Instagram on every plan; account count unlimited (JSON null) until the owner
-- sets real limits.
UPDATE plans SET features = features || '{"instagram":true}'::jsonb,
  limits = limits || '{"instagram_accounts":null}'::jsonb
  WHERE id IN ('free','basic','pro','enterprise');
