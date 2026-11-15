SET LOCAL lock_timeout = '5s';

-- Store plan Phase 4, package 4: full Meta catalogue sync. Bodhinox creates and
-- updates products in the connected Meta catalogue. Additive.
--
-- shop_meta_sync_settings  one row per workspace: the opt-in (off by default) and
--   which products sync: every published product ('all'), or only the products
--   an admin picked ('selected', product_ids). Admins write it; members read it.
-- shop_meta_sync_items     one row per variant: where its Meta item stands.
--   not_synced  nothing sent, or a send that Meta provably refused before applying
--   pending     a batch was claimed (intent_key) and, once Meta answered, has a handle to poll
--   synced      Meta finished the batch without an error for this item
--   failed      refused, with a fixed error_code (and Meta's numeric code in error_detail)
--   uncertain   a CREATE whose outcome is unknown; never sent again until an admin
--               reconciles it (reads the item from Meta), which sets synced or not_synced
--   The worker writes it. An admin may only resolve an uncertain row (reconcile).
--   Product names and prices are never stored here; pushed_hash is a digest.
-- queue_meta_catalogue_sync() queues one 'commerce.meta_catalogue_sync' job per
--   workspace per minute, in the transaction of any change to what an item shows
--   in Meta (variants, products, stock crossing zero, product pictures), only
--   while the workspace has opted in. SECURITY INVOKER, like queue_catalog_push().

CREATE TABLE shop_meta_sync_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all','selected')),
  product_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(product_ids) <= 2000),
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE shop_meta_sync_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_meta_sync_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_meta_sync_settings FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_meta_sync_settings FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON shop_meta_sync_settings TO bodhinox_worker;
GRANT SELECT ON shop_meta_sync_settings TO bodhinox_app;
GRANT INSERT (account_id, enabled, scope, product_ids, updated_by) ON shop_meta_sync_settings TO bodhinox_app;
GRANT UPDATE (enabled, scope, product_ids, updated_by, updated_at) ON shop_meta_sync_settings TO bodhinox_app;

CREATE TABLE shop_meta_sync_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  -- Meta's catalogue id and the SKU the state refers to.
  catalog_id text NOT NULL CHECK (catalog_id ~ '^[0-9]{1,32}$'),
  retailer_id text NOT NULL CHECK (char_length(retailer_id) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'not_synced' CHECK (status IN ('not_synced','pending','synced','failed','uncertain')),
  method text CHECK (method IN ('CREATE','UPDATE')),
  -- The item is known to exist in Meta (a finished batch or a reconcile found it).
  in_meta boolean NOT NULL DEFAULT false,
  pushed_hash text CHECK (pushed_hash ~ '^[0-9a-f]{64}$'),
  intent_key text CHECK (char_length(intent_key) <= 300),
  batch_handle text CHECK (char_length(batch_handle) <= 500),
  meta_product_id text CHECK (meta_product_id ~ '^[0-9]{1,32}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  error_detail text CHECK (error_detail ~ '^[A-Za-z0-9_ .:/-]{1,100}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_pushed_at timestamptz,
  last_checked_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, variant_id),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE,
  CHECK (status <> 'pending' OR intent_key IS NOT NULL)
);
CREATE INDEX shop_meta_sync_items_status_idx ON shop_meta_sync_items (account_id, status);

ALTER TABLE shop_meta_sync_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_meta_sync_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_meta_sync_items FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
-- Reconcile: an admin resolves an uncertain row to synced or not_synced, nothing else.
CREATE POLICY admin_reconcile ON shop_meta_sync_items FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin') AND status='uncertain')
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin') AND status IN ('synced','not_synced'));
CREATE POLICY worker_write ON shop_meta_sync_items FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shop_meta_sync_items TO bodhinox_app;
GRANT UPDATE (status, in_meta, pushed_hash, intent_key, meta_product_id, error_code, error_detail, last_checked_at, synced_at, updated_at)
  ON shop_meta_sync_items TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON shop_meta_sync_items TO bodhinox_worker;

CREATE FUNCTION queue_meta_catalogue_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE acct uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN acct := OLD.account_id; ELSE acct := NEW.account_id; END IF;
  IF EXISTS (SELECT 1 FROM shop_meta_sync_settings s WHERE s.account_id = acct AND s.enabled) THEN
    INSERT INTO jobs(type, tenant_id, payload, dedupe_key, run_at, max_attempts)
    VALUES ('commerce.meta_catalogue_sync', acct, '{}'::jsonb,
      'meta-catalogue-sync:' || acct::text || ':' || floor(extract(epoch FROM now()) / 60)::bigint::text,
      date_trunc('minute', now()) + interval '1 minute', 3)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER shop_variants_meta_sync AFTER INSERT ON shop_variants
  FOR EACH ROW EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
CREATE TRIGGER shop_variants_meta_sync_update AFTER UPDATE OF sku, price_minor, archived_at, track_inventory, option_values, image_id ON shop_variants
  FOR EACH ROW
  WHEN (OLD.sku IS DISTINCT FROM NEW.sku OR OLD.price_minor IS DISTINCT FROM NEW.price_minor
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at OR OLD.track_inventory IS DISTINCT FROM NEW.track_inventory
    OR OLD.option_values IS DISTINCT FROM NEW.option_values OR OLD.image_id IS DISTINCT FROM NEW.image_id)
  EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
CREATE TRIGGER shop_products_meta_sync AFTER UPDATE OF status, name, description, brand ON shop_products
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.name IS DISTINCT FROM NEW.name
    OR OLD.description IS DISTINCT FROM NEW.description OR OLD.brand IS DISTINCT FROM NEW.brand)
  EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
CREATE TRIGGER inventory_levels_meta_sync AFTER INSERT ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
CREATE TRIGGER inventory_levels_meta_sync_update AFTER UPDATE OF on_hand, reserved ON inventory_levels
  FOR EACH ROW WHEN ((OLD.on_hand - OLD.reserved > 0) IS DISTINCT FROM (NEW.on_hand - NEW.reserved > 0))
  EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
CREATE TRIGGER shop_product_images_meta_sync AFTER INSERT OR UPDATE OR DELETE ON shop_product_images
  FOR EACH ROW EXECUTE FUNCTION queue_meta_catalogue_sync(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows
