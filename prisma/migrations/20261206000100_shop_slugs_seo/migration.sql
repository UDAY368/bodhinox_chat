SET LOCAL lock_timeout = '5s';

-- Store Batch 6: readable product and category addresses, and a product's own search-engine listing. Additive.
-- - shop_products.slug and shop_categories.slug: /s/<handle>/p/<slug> and /c/<slug>. The collection format
--   (^[a-z0-9]+(-[a-z0-9]+)*$, at most 60), unique per workspace by the partial unique indexes of the next two
--   migrations (CREATE INDEX CONCURRENTLY, one per migration). Null only for a row the previous release made while
--   this ran; the app links such a row by its id and gives it a slug on its next save.
-- - shop_products.seo_title (<= 70), seo_description (<= 160) and seo_image_id (one of the product's OWN images:
--   composite foreign key, cleared when that image is removed). Empty means "use the name, description, first image".
-- Existing rows get a slug from their name here (lower-case latin, hyphens, at most 60; "-2", "-3" ... per workspace
-- for a repeated name; a name with nothing latin falls back to the first 8 characters of the id), the same rules as
-- slugBase() in src/lib/commerce/shop-paths.ts. The backfill moves updated_at to now() once for every product and
-- category (the set_updated_at trigger); nothing reads updated_at but the dashboard list and the new sitemap.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261206000100_shop_slugs_seo, then deploy again.

ALTER TABLE shop_products
  ADD COLUMN slug text CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60)),
  ADD COLUMN seo_title text CHECK (seo_title IS NULL OR char_length(btrim(seo_title)) BETWEEN 1 AND 70),
  ADD COLUMN seo_description text CHECK (seo_description IS NULL OR char_length(btrim(seo_description)) BETWEEN 1 AND 160),
  ADD COLUMN seo_image_id uuid;
ALTER TABLE shop_categories
  ADD COLUMN slug text CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) <= 60));

-- MATCH SIMPLE: a null seo_image_id is not checked; a set one must be an image of this product in this workspace.
ALTER TABLE shop_products ADD CONSTRAINT shop_products_seo_image_fkey
  FOREIGN KEY (account_id, id, seo_image_id) REFERENCES shop_product_images(account_id, product_id, id) ON DELETE SET NULL (seo_image_id) NOT VALID;
-- Every row has a null seo_image_id (the column was just added), so validating takes only a moment.
ALTER TABLE shop_products VALIDATE CONSTRAINT shop_products_seo_image_fkey;

GRANT UPDATE (slug, seo_title, seo_description, seo_image_id) ON shop_products TO bodhinox_app;
GRANT UPDATE (slug) ON shop_categories TO bodhinox_app;

-- The base slug of a name (see the header); used by the backfill below and kept for support queries.
CREATE FUNCTION shop_slug_base(p_name text, p_id uuid) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE base text;
BEGIN
  base := regexp_replace(lower(regexp_replace(normalize(COALESCE(p_name, ''), NFKD), '[̀-ͯ]', '', 'g')), '[^a-z0-9]+', '-', 'g');
  base := rtrim(left(btrim(base, '-'), 60), '-');
  IF base = '' THEN base := left(replace(p_id::text, '-', ''), 8); END IF;
  IF base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN base := left(base, 58) || '-x'; END IF;
  RETURN base;
END $$;

-- Oldest first, so the first product of a name keeps the plain slug. Workspaces hold at most a few thousand rows.
DO $$
DECLARE r record; base text; candidate text; n int;
BEGIN
  FOR r IN SELECT id, account_id, name FROM shop_products WHERE slug IS NULL ORDER BY account_id, created_at, id LOOP
    base := shop_slug_base(r.name, r.id); candidate := base; n := 1;
    WHILE EXISTS (SELECT 1 FROM shop_products WHERE account_id = r.account_id AND slug = candidate) LOOP
      n := n + 1;
      candidate := rtrim(left(base, 60 - length(n::text) - 1), '-') || '-' || n::text;
    END LOOP;
    UPDATE shop_products SET slug = candidate WHERE id = r.id;
  END LOOP;
  FOR r IN SELECT id, account_id, name FROM shop_categories WHERE slug IS NULL ORDER BY account_id, created_at, id LOOP
    base := shop_slug_base(r.name, r.id); candidate := base; n := 1;
    WHILE EXISTS (SELECT 1 FROM shop_categories WHERE account_id = r.account_id AND slug = candidate) LOOP
      n := n + 1;
      candidate := rtrim(left(base, 60 - length(n::text) - 1), '-') || '-' || n::text;
    END LOOP;
    UPDATE shop_categories SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;
