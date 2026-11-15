SET LOCAL lock_timeout = '5s';

-- Store plan Phase 4, package 3: import products from a connected Shopify or
-- WooCommerce store. Additive. shop_platform_imports holds one queued import:
-- which platform, where it got to (a page cursor the worker saves after every
-- page, so a restart resumes instead of starting over), counters, a capped
-- list of row errors (row number, column and code only, never product content)
-- and, for WooCommerce, the consumer key and secret the admin typed, encrypted
-- and cleared when the job ends. Admins queue a row and ask for a cancel through
-- the app role and read everything except the credentials and the cursor;
-- the worker updates progress. One queued or running import per workspace.

CREATE TABLE shop_platform_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('shopify','woocommerce')),
  -- The shop domain or store URL shown to the admin (never a credential).
  source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 4 AND 300),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
  credentials_enc text CHECK (credentials_enc IS NULL OR char_length(credentials_enc) <= 2000),
  cursor text CHECK (cursor IS NULL OR char_length(cursor) <= 1000),
  cancel_requested boolean NOT NULL DEFAULT false,
  pages_done integer NOT NULL DEFAULT 0 CHECK (pages_done >= 0),
  products_seen integer NOT NULL DEFAULT 0 CHECK (products_seen >= 0),
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) <= 200),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (account_id, id),
  CHECK (platform <> 'woocommerce' OR status NOT IN ('queued','running') OR credentials_enc IS NOT NULL)
);
CREATE UNIQUE INDEX shop_platform_imports_one_active ON shop_platform_imports (account_id) WHERE status IN ('queued','running');
CREATE INDEX shop_platform_imports_account_idx ON shop_platform_imports (account_id, created_at DESC);

ALTER TABLE shop_platform_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_platform_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON shop_platform_imports FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY admin_insert ON shop_platform_imports FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'queued' AND requested_by = app_user_id());
CREATE POLICY admin_cancel ON shop_platform_imports FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_all ON shop_platform_imports FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- The browser never reads the credentials or the cursor back.
GRANT SELECT (id, account_id, requested_by, platform, source_url, status, cancel_requested, pages_done, products_seen, created_count,
  updated_count, skipped_count, error_count, errors, error_code, created_at, started_at, completed_at) ON shop_platform_imports TO bodhinox_app;
GRANT INSERT (account_id, requested_by, platform, source_url, credentials_enc) ON shop_platform_imports TO bodhinox_app;
GRANT UPDATE (cancel_requested) ON shop_platform_imports TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shop_platform_imports TO bodhinox_worker;
