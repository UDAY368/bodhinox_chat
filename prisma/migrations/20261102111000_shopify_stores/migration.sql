-- Phase 6: Shopify store connection. One store per workspace, connected by the
-- Shopify OAuth install flow. The offline access token is encrypted by the app
-- (AES-GCM, src/lib/whatsapp/encryption.ts) and the app role can never read it:
-- members see only the non-secret columns, admins connect and change settings,
-- and the worker reads the token for server-side Shopify calls and records
-- uninstall / GDPR redaction. Additive only.

CREATE TABLE shopify_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' AND char_length(shop_domain) <= 255),
  -- Null once the app is uninstalled (Shopify revokes the token then).
  access_token_enc text CHECK (char_length(access_token_enc) <= 4096),
  scopes text NOT NULL DEFAULT '' CHECK (char_length(scopes) <= 1000),
  installed_at timestamptz NOT NULL DEFAULT now(),
  uninstalled_at timestamptz,
  -- When true, marketing messages (abandoned checkout, Marketing templates) go only
  -- to customers the store reports as subscribed; unknown consent counts as no.
  marketing_opt_in_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id),
  UNIQUE (account_id, id),
  CHECK (uninstalled_at IS NOT NULL OR access_token_enc IS NOT NULL)
);
-- A store is installed in at most one workspace at a time. An uninstalled row is
-- kept (token cleared) until Shopify's shop/redact, so the domain may then be
-- installed elsewhere.
CREATE UNIQUE INDEX shopify_stores_active_domain_key ON shopify_stores(shop_domain) WHERE uninstalled_at IS NULL;
CREATE INDEX shopify_stores_domain_idx ON shopify_stores(shop_domain);
ALTER TABLE shopify_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopify_stores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shopify_stores FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON shopify_stores FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON shopify_stores FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
-- The app role never reads the token: column grants only.
GRANT SELECT (id, account_id, shop_domain, scopes, installed_at, uninstalled_at, marketing_opt_in_only, created_at)
  ON shopify_stores TO bodhinox_app;
GRANT INSERT (account_id, shop_domain, access_token_enc, scopes, installed_at, uninstalled_at, marketing_opt_in_only)
  ON shopify_stores TO bodhinox_app;
GRANT UPDATE (shop_domain, access_token_enc, scopes, installed_at, uninstalled_at, marketing_opt_in_only)
  ON shopify_stores TO bodhinox_app;
GRANT SELECT, UPDATE, DELETE ON shopify_stores TO bodhinox_worker;

-- The one cross-tenant lookup a Shopify webhook needs: shop domain -> workspaces.
-- Returns the active install first, then uninstalled rows awaiting shop/redact.
CREATE FUNCTION crm_resolve_shopify_store(p_domain text)
RETURNS TABLE(account_id uuid, store_id uuid, active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id, s.id, s.uninstalled_at IS NULL
  FROM shopify_stores s WHERE s.shop_domain=p_domain
  ORDER BY (s.uninstalled_at IS NULL) DESC, s.installed_at DESC
  LIMIT 20
$$;
REVOKE ALL ON FUNCTION crm_resolve_shopify_store(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_shopify_store(text) TO bodhinox_worker;
-- FORCE RLS applies to the definer too (same pattern as migration_owner).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY shopify_resolve_owner ON shopify_stores FOR SELECT TO %I USING (true)', current_user);
END $$;

-- Uninstall stops the store's rules. The worker may only switch a rule off.
GRANT UPDATE (enabled) ON commerce_event_rules TO bodhinox_worker;
CREATE POLICY worker_disable ON commerce_event_rules FOR UPDATE TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id() AND enabled=false);

-- GDPR redaction anonymises store events and store orders for a customer.
-- (commerce_events: the worker already has SELECT, INSERT, UPDATE.)
