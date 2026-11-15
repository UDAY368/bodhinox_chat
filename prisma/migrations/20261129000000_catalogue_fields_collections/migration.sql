SET LOCAL lock_timeout = '5s';

-- Store plan Phase 4, package 1: a stronger catalogue. Additive.
-- shop_products gets tags, brand, product type and detail rows (label/value
-- plain text). shop_variants.image_id points at one image of the SAME
-- product: a composite foreign key (account, product, image) enforces it in
-- the database, and a deleted image clears the pointer. shop_collections
-- groups products by hand (shop_collection_products) or by fixed rules the
-- server turns into parameterised SQL; admins write them, the public shop
-- reads published collections through the worker.

-- ================================================================ product fields
CREATE FUNCTION shop_tags_valid(p_tags text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(p_tags) <= 20
    AND NOT EXISTS (SELECT 1 FROM unnest(p_tags) t WHERE t IS NULL OR char_length(t) NOT BETWEEN 1 AND 40 OR t <> lower(btrim(t)))
    AND (SELECT count(DISTINCT t) FROM unnest(p_tags) t) = cardinality(p_tags)
$$;

ALTER TABLE shop_products
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (shop_tags_valid(tags)),
  ADD COLUMN brand text CHECK (brand IS NULL OR char_length(btrim(brand)) BETWEEN 1 AND 80),
  ADD COLUMN product_type text CHECK (product_type IS NULL OR char_length(btrim(product_type)) BETWEEN 1 AND 80),
  ADD COLUMN details jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(details) = 'array' AND jsonb_array_length(details) <= 12 AND pg_column_size(details) <= 6144);
GRANT UPDATE (tags, brand, product_type, details) ON shop_products TO bodhinox_app;

-- ================================================================ variant image
ALTER TABLE shop_product_images ADD CONSTRAINT shop_product_images_product_id_key UNIQUE (account_id, product_id, id);
ALTER TABLE shop_variants ADD COLUMN image_id uuid;
-- MATCH SIMPLE: a null image_id is not checked; a set one must be an image of this variant's own product in this account.
ALTER TABLE shop_variants ADD CONSTRAINT shop_variants_image_same_product_fkey
  FOREIGN KEY (account_id, product_id, image_id) REFERENCES shop_product_images(account_id, product_id, id) ON DELETE SET NULL (image_id) NOT VALID;
-- Every existing row has a null image_id (the column was just added), so validating takes only a moment.
ALTER TABLE shop_variants VALIDATE CONSTRAINT shop_variants_image_same_product_fkey;
GRANT UPDATE (image_id) ON shop_variants TO bodhinox_app;

-- ================================================================ collections
CREATE TABLE shop_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart')),
  -- Fixed shape [{field, op, value}], at most 10, validated and compiled by the server (never raw SQL).
  rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 10 AND pg_column_size(rules) <= 4096),
  match text NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  sort text NOT NULL DEFAULT 'featured' CHECK (sort IN ('featured','price_asc','price_desc','name','newest')),
  published boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, slug)
);

CREATE TABLE shop_collection_products (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  product_id uuid NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, collection_id, product_id),
  FOREIGN KEY (account_id, collection_id) REFERENCES shop_collections(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_collection_products_product_idx ON shop_collection_products (account_id, product_id);

-- ================================================================ RLS
-- Agents read; admins write through the app role; the public shop reads through the worker.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_collections','shop_collection_products']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY tenant_write ON %I FOR ALL TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed(%L)) WITH CHECK (account_id=app_account_id() AND app_write_allowed(%L))', t, 'admin', 'admin');
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON shop_collections TO bodhinox_app;
GRANT UPDATE (title, slug, description, kind, rules, match, sort, published, updated_at) ON shop_collections TO bodhinox_app;
GRANT SELECT, INSERT, DELETE ON shop_collection_products TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_collections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
