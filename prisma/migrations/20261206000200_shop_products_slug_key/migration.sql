CREATE UNIQUE INDEX CONCURRENTLY shop_products_slug_key ON shop_products (account_id, slug) WHERE slug IS NOT NULL;
