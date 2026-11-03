-- Phase 10: Click-to-WhatsApp ads. One Meta ad account + Facebook Page connection
-- per workspace, made through Facebook Login for Business. The user and Page
-- tokens are encrypted by the app (AES-GCM, src/lib/whatsapp/encryption.ts) and
-- the app role can never read them: members see only the non-secret columns,
-- admins change the CAPI settings, and every connect/disconnect write and every
-- token read goes through the worker inside withTenant. Nothing here calls Meta;
-- the feature stays off until META_ADS_ENABLED and its config are set. Additive.

CREATE TABLE meta_ad_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  -- Historical audit identity of the admin who started the connection.
  connected_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','token_invalid','disconnected')),
  business_id text CHECK (business_id ~ '^\d{1,32}$'),
  -- Without the 'act_' prefix.
  ad_account_id text CHECK (ad_account_id ~ '^\d{1,32}$'),
  ad_account_name text CHECK (char_length(ad_account_name) <= 500),
  ad_account_currency text CHECK (ad_account_currency ~ '^[A-Z]{3}$'),
  page_id text CHECK (page_id ~ '^\d{1,32}$'),
  page_name text CHECK (char_length(page_name) <= 500),
  -- encrypt() output (iv:ct:tag). '' once cleared on disconnect.
  user_token_enc text NOT NULL DEFAULT '' CHECK (char_length(user_token_enc) <= 8192),
  page_token_enc text NOT NULL DEFAULT '' CHECK (char_length(page_token_enc) <= 8192),
  token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}' CHECK (cardinality(scopes) <= 100),
  page_subscribed_at timestamptz,
  capi_enabled boolean NOT NULL DEFAULT false,
  capi_dataset_id text CHECK (capi_dataset_id ~ '^\d{1,32}$'),
  -- A CAPI dataset belongs to one WABA. Events are sent only for referrals that
  -- arrived on this number's WABA.
  capi_whatsapp_config_id uuid,
  capi_waba_id text CHECK (capi_waba_id ~ '^\d{1,32}$'),
  capi_auto_purchase boolean NOT NULL DEFAULT true,
  capi_auto_lead boolean NOT NULL DEFAULT false,
  insights_synced_at timestamptz,
  leads_synced_at timestamptz,
  -- Meta code[:subcode] only, never a message body.
  last_error_code text CHECK (last_error_code ~ '^[0-9:]{0,32}$'),
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, capi_whatsapp_config_id) REFERENCES whatsapp_config(account_id, id)
    ON DELETE SET NULL (capi_whatsapp_config_id)
);
-- One live connection per workspace (a pending row is reused, never duplicated).
-- shortcut: multiple ad accounts or Pages per workspace are not supported yet.
CREATE UNIQUE INDEX meta_ad_connections_one_live ON meta_ad_connections(account_id) WHERE status <> 'disconnected';
-- A Page stays owned while its token is invalid; only disconnect frees it for another workspace.
CREATE UNIQUE INDEX meta_ad_connections_page_live ON meta_ad_connections(page_id) WHERE status IN ('active','token_invalid');

ALTER TABLE meta_ad_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON meta_ad_connections FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON meta_ad_connections FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON meta_ad_connections FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- The app role never reads a token: column grants only.
GRANT SELECT (id, account_id, connected_by, status, business_id, ad_account_id, ad_account_name, ad_account_currency,
  page_id, page_name, token_expires_at, scopes, page_subscribed_at, capi_enabled, capi_dataset_id,
  capi_whatsapp_config_id, capi_waba_id, capi_auto_purchase, capi_auto_lead, insights_synced_at, leads_synced_at,
  last_error_code, connected_at, disconnected_at, created_at, updated_at)
  ON meta_ad_connections TO bodhinox_app;
GRANT UPDATE (capi_enabled, capi_auto_purchase, capi_auto_lead, capi_whatsapp_config_id, updated_at)
  ON meta_ad_connections TO bodhinox_app;
-- Rows are kept as 'disconnected' for audit: no DELETE for either role.
GRANT SELECT, INSERT, UPDATE ON meta_ad_connections TO bodhinox_worker;

-- FORCE RLS applies to the definer too (same pattern as shopify_resolve_owner).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY meta_ads_resolve_owner ON meta_ad_connections FOR SELECT TO %I USING (true)', current_user);
END $$;

-- Page webhook: Page id -> the workspace holding it as an active connection.
CREATE FUNCTION crm_resolve_page_account(p_page_id text)
RETURNS TABLE(account_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.account_id, c.id FROM meta_ad_connections c
  WHERE p_page_id ~ '^\d{1,32}$' AND c.page_id = p_page_id AND c.status = 'active'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crm_resolve_page_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_page_account(text) TO bodhinox_worker;

-- Scheduler: active connections and when they last synced.
CREATE FUNCTION crm_meta_ad_connections_due()
RETURNS TABLE(account_id uuid, insights_synced_at timestamptz, leads_synced_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.account_id, c.insights_synced_at, c.leads_synced_at FROM meta_ad_connections c
  WHERE c.status = 'active'
  ORDER BY c.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_meta_ad_connections_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_meta_ad_connections_due() TO bodhinox_worker;

-- Connect-time cross-tenant check: which workspace holds this Page (active or token_invalid)?
CREATE FUNCTION crm_page_owner_account(p_page_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT c.account_id FROM meta_ad_connections c
  WHERE p_page_id ~ '^\d{1,32}$' AND c.page_id = p_page_id AND c.status IN ('active','token_invalid')
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION crm_page_owner_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_page_owner_account(text) TO bodhinox_worker;
