CREATE UNIQUE INDEX CONCURRENTLY shop_categories_slug_key ON shop_categories (account_id, slug) WHERE slug IS NOT NULL;
