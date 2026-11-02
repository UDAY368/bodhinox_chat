-- WooCommerce store connections. Each store posts order webhooks to
-- /api/integrations/woocommerce/webhook/<id>, signed with a secret we generate
-- (shown to the admin once, stored encrypted). The app role can never read the
-- secret column; the public webhook resolves the store's account through one
-- SECURITY DEFINER lookup and then reads the secret as the worker, in tenant scope.
CREATE TABLE woocommerce_stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  store_url text NOT NULL CHECK (char_length(store_url) BETWEEN 10 AND 300 AND store_url ~ '^https?://'),
  webhook_secret_enc text NOT NULL CHECK (char_length(webhook_secret_enc) BETWEEN 1 AND 4000),
  -- Optional order meta key holding the customer's marketing consent (yes/no).
  consent_meta_key text CHECK (consent_meta_key ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  connected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, store_url),
  UNIQUE (account_id, id)
);
CREATE INDEX woocommerce_stores_tenant_idx ON woocommerce_stores (account_id);
ALTER TABLE woocommerce_stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE woocommerce_stores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON woocommerce_stores FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON woocommerce_stores FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT (id, account_id, store_url, consent_meta_key, connected_at, created_at) ON woocommerce_stores TO bodhinox_app;
GRANT INSERT, DELETE ON woocommerce_stores TO bodhinox_app;
GRANT UPDATE (consent_meta_key) ON woocommerce_stores TO bodhinox_app;
GRANT SELECT ON woocommerce_stores TO bodhinox_worker;

-- The only cross-tenant lookup the public webhook needs: store id -> account.
CREATE FUNCTION resolve_woocommerce_store(p_store_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM woocommerce_stores s WHERE s.id=p_store_id
$$;
-- FORCE RLS applies to the owner too; this policy grants the definer its projection.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY woo_migration_owner ON woocommerce_stores FOR SELECT TO %I USING (true)',current_user);
END $$;
REVOKE ALL ON FUNCTION resolve_woocommerce_store(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_woocommerce_store(uuid) TO bodhinox_worker;
