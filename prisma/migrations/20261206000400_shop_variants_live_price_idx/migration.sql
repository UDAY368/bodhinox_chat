-- Store Batch 6 (speed): the public shop's lists are filtered, sorted and paged in SQL (src/lib/commerce/shop-products.ts).
-- Each listed product's lowest live price (the price sorts, the price filter and "has a priced variant") is read from its live,
-- priced variants; this index answers that from the index alone instead of the variant rows. The existing
-- shop_variants_product_idx (account_id, product_id, position) still serves the card loader's variant read.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY cannot run inside a transaction block (the shop
-- keeps taking orders while it builds). If a deploy is interrupted mid-build, PostgreSQL leaves an INVALID index; drop it
-- (DROP INDEX CONCURRENTLY shop_variants_live_price_idx) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261206000400_shop_variants_live_price_idx) before re-running.
CREATE INDEX CONCURRENTLY shop_variants_live_price_idx ON shop_variants (account_id, product_id, price_minor) WHERE archived_at IS NULL AND price_minor IS NOT NULL;
