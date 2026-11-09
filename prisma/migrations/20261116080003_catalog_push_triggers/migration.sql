-- Price and stock set in Bodhinox reach the linked Meta catalogue (audit
-- finding 20).
--
-- queue_catalog_push() queues one 'commerce.catalog_push' job for the
-- workspace when something that decides a linked item's price or
-- availability changes, in the same transaction as the change, whichever
-- code path made it:
--   shop_variants     a new variant, or a change of sku, price, archive or stock tracking
--   shop_products     a change of status (only published products are sellable)
--   inventory_levels  a new level, or available stock (on_hand - reserved) moving between
--                     zero and above zero; other stock moves leave availability unchanged
-- Only when the workspace has a mirrored Meta product whose retailer_id is one
-- of the affected SKUs (a linked variant). The job runs at the start of the
-- next minute and is deduped per workspace per minute, so a burst of changes
-- makes one push that reads the state as it is then; a change after the job
-- ran queues the next minute's job. The job itself compares and pushes (see
-- src/lib/commerce/catalog-push.ts); every push is an absolute price /
-- availability, so repeating one is harmless. Ids only in the payload.
--
-- SECURITY INVOKER: the app role (variants, products) and the worker role
-- (stock, lib/commerce/stock.ts) are already scoped to the tenant by RLS and
-- may insert jobs for that tenant only.
-- Additive: one function and three triggers; no table is rewritten.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION queue_catalog_push() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE linked boolean;
BEGIN
  IF TG_TABLE_NAME = 'shop_variants' THEN
    linked := EXISTS (SELECT 1 FROM products m WHERE m.account_id = NEW.account_id
      AND (m.retailer_id = NEW.sku OR (TG_OP = 'UPDATE' AND m.retailer_id = OLD.sku)));
  ELSIF TG_TABLE_NAME = 'shop_products' THEN
    linked := EXISTS (SELECT 1 FROM shop_variants v JOIN products m ON m.account_id = v.account_id AND m.retailer_id = v.sku
      WHERE v.account_id = NEW.account_id AND v.product_id = NEW.id);
  ELSE
    linked := EXISTS (SELECT 1 FROM shop_variants v JOIN products m ON m.account_id = v.account_id AND m.retailer_id = v.sku
      WHERE v.account_id = NEW.account_id AND v.id = NEW.variant_id);
  END IF;
  IF linked THEN
    INSERT INTO jobs(type, tenant_id, payload, dedupe_key, run_at, max_attempts)
    VALUES ('commerce.catalog_push', NEW.account_id, '{}'::jsonb,
      'catalog-push:' || NEW.account_id::text || ':' || floor(extract(epoch FROM now()) / 60)::bigint::text,
      date_trunc('minute', now()) + interval '1 minute', 3)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER shop_variants_catalog_push AFTER INSERT ON shop_variants
  FOR EACH ROW EXECUTE FUNCTION queue_catalog_push();
CREATE TRIGGER shop_variants_catalog_push_update AFTER UPDATE OF sku, price_minor, archived_at, track_inventory ON shop_variants
  FOR EACH ROW
  WHEN (OLD.sku IS DISTINCT FROM NEW.sku OR OLD.price_minor IS DISTINCT FROM NEW.price_minor
    OR OLD.archived_at IS DISTINCT FROM NEW.archived_at OR OLD.track_inventory IS DISTINCT FROM NEW.track_inventory)
  EXECUTE FUNCTION queue_catalog_push();
CREATE TRIGGER shop_products_catalog_push AFTER UPDATE OF status ON shop_products
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION queue_catalog_push();
CREATE TRIGGER inventory_levels_catalog_push AFTER INSERT ON inventory_levels
  FOR EACH ROW EXECUTE FUNCTION queue_catalog_push();
CREATE TRIGGER inventory_levels_catalog_push_update AFTER UPDATE OF on_hand, reserved ON inventory_levels
  FOR EACH ROW WHEN ((OLD.on_hand - OLD.reserved > 0) IS DISTINCT FROM (NEW.on_hand - NEW.reserved > 0))
  EXECUTE FUNCTION queue_catalog_push();
