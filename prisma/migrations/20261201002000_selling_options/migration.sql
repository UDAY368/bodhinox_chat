SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 3: selling options. Additive; every existing product, variant and order keeps selling as before.
--
-- Pre-orders (shop_variants.preorder / preorder_ship_date / preorder_cap): a variant on pre-order sells past zero
--   stock. Units that are in stock are still reserved the usual way; the rest is simply promised for the ship date.
--   preorder_cap is the most units taken on pre-order that are still open (not cancelled, expired or fully refunded);
--   null = no limit. The line keeps the ship date (order_items.preorder_ship_date) and the order keeps the latest
--   one (orders.preorder_ship_date); an order with a ship date is a pre-order.
-- Bundles (shop_products.is_bundle + shop_bundle_parts): a bundle is a product with its own price whose variants
--   are made of parts (variant + quantity). Checkout reserves, and returns restock, each part (stock.ts).
--   Bundle availability = the smallest whole number of bundles the parts allow (shop_variant_availability).
-- Digital products (shop_products.is_digital + digital_media_id / digital_url): no shipping; after payment a queued
--   job sends a signed, expiring download link. The send is the order_messages kind 'digital_delivery', so a refusal
--   (no approved template outside the 24 hour window) or an uncertain send shows on the order.
-- Scheduled publish and hide (shop_products.publish_at / hide_at): read at query time by shop_product_live().
-- Shop access (shop_storefronts.access_mode / access_password_hash / coming_soon_message): open, password or
--   coming soon. The hash is never returned by any browser API.
-- Two functions keep every reader (shop pages, cart, WhatsApp catalogue, staff order picker) on one rule:
--   shop_product_live(status, publish_at, hide_at) and shop_variant_availability(account, variant) (null = no limit).
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201002000_selling_options.

-- ================================================================ products
ALTER TABLE shop_products ADD COLUMN publish_at timestamptz;
ALTER TABLE shop_products ADD COLUMN hide_at timestamptz;
ALTER TABLE shop_products ADD COLUMN is_digital boolean NOT NULL DEFAULT false;
ALTER TABLE shop_products ADD COLUMN digital_media_id uuid;
ALTER TABLE shop_products ADD COLUMN digital_url text;
ALTER TABLE shop_products ADD COLUMN is_bundle boolean NOT NULL DEFAULT false;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_schedule_check
  CHECK (publish_at IS NULL OR hide_at IS NULL OR hide_at > publish_at) NOT VALID;
ALTER TABLE shop_products VALIDATE CONSTRAINT shop_products_schedule_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_digital_check
  CHECK (NOT (is_digital AND is_bundle) AND (is_digital OR (digital_media_id IS NULL AND digital_url IS NULL))
    AND (digital_media_id IS NULL OR digital_url IS NULL)
    AND (digital_url IS NULL OR (char_length(digital_url) <= 2048 AND digital_url ~ '^https://'))) NOT VALID;
ALTER TABLE shop_products VALIDATE CONSTRAINT shop_products_digital_check;
ALTER TABLE shop_products ADD CONSTRAINT shop_products_digital_media_fk
  FOREIGN KEY (account_id, digital_media_id) REFERENCES media_objects(account_id, id) ON DELETE SET NULL (digital_media_id) NOT VALID;
ALTER TABLE shop_products VALIDATE CONSTRAINT shop_products_digital_media_fk;
GRANT UPDATE (publish_at, hide_at, is_digital, digital_media_id, digital_url, is_bundle) ON shop_products TO bodhinox_app;

-- ================================================================ variants
ALTER TABLE shop_variants ADD COLUMN preorder boolean NOT NULL DEFAULT false;
ALTER TABLE shop_variants ADD COLUMN preorder_ship_date date;
ALTER TABLE shop_variants ADD COLUMN preorder_cap integer;
ALTER TABLE shop_variants ADD CONSTRAINT shop_variants_preorder_check
  CHECK ((NOT preorder OR preorder_ship_date IS NOT NULL) AND (preorder_cap IS NULL OR preorder_cap BETWEEN 1 AND 1000000)) NOT VALID;
ALTER TABLE shop_variants VALIDATE CONSTRAINT shop_variants_preorder_check;
GRANT UPDATE (preorder, preorder_ship_date, preorder_cap) ON shop_variants TO bodhinox_app;

-- ================================================================ orders
ALTER TABLE order_items ADD COLUMN preorder_ship_date date;
-- A bundle line keeps the parts it was sold with ([{variant_id, quantity}] per bundle), so a cancel or return puts back what was sold.
ALTER TABLE order_items ADD COLUMN bundle_parts jsonb;
ALTER TABLE orders ADD COLUMN preorder_ship_date date;

-- ================================================================ bundle parts
CREATE TABLE shop_bundle_parts (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  part_variant_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, product_id, part_variant_id),
  FOREIGN KEY (account_id, product_id) REFERENCES shop_products(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, part_variant_id) REFERENCES shop_variants(account_id, id) ON DELETE RESTRICT
);
CREATE INDEX shop_bundle_parts_variant_idx ON shop_bundle_parts (account_id, part_variant_id);

-- Only a bundle product has parts, and a part is an ordinary physical variant of another product (no nesting).
CREATE FUNCTION shop_bundle_parts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shop_products WHERE account_id=NEW.account_id AND id=NEW.product_id AND is_bundle) THEN
    RAISE EXCEPTION 'bundle_not_enabled' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      WHERE v.account_id=NEW.account_id AND v.id=NEW.part_variant_id AND (p.is_bundle OR p.is_digital OR p.id=NEW.product_id)) THEN
    RAISE EXCEPTION 'bundle_part_invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_bundle_parts_guard BEFORE INSERT ON shop_bundle_parts FOR EACH ROW EXECUTE FUNCTION shop_bundle_parts_guard();

-- A product that is already a part of a bundle cannot itself become a bundle.
CREATE FUNCTION shop_products_bundle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_bundle AND NOT OLD.is_bundle AND EXISTS (SELECT 1 FROM shop_bundle_parts b JOIN shop_variants v ON v.account_id=b.account_id
      AND v.id=b.part_variant_id WHERE v.account_id=NEW.account_id AND v.product_id=NEW.id) THEN
    RAISE EXCEPTION 'bundle_part_invalid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shop_products_bundle_guard BEFORE UPDATE OF is_bundle ON shop_products FOR EACH ROW EXECUTE FUNCTION shop_products_bundle_guard(); -- additive-exception: fires only when is_bundle is updated; a brief lock on a small table

ALTER TABLE shop_bundle_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_bundle_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_bundle_parts FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_bundle_parts FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, DELETE ON shop_bundle_parts TO bodhinox_app;
GRANT UPDATE (quantity, position) ON shop_bundle_parts TO bodhinox_app;
GRANT SELECT ON shop_bundle_parts TO bodhinox_worker;

-- ================================================================ shop access
ALTER TABLE shop_storefronts ADD COLUMN access_mode text NOT NULL DEFAULT 'open';
ALTER TABLE shop_storefronts ADD COLUMN access_password_hash text;
ALTER TABLE shop_storefronts ADD COLUMN coming_soon_message text;
ALTER TABLE shop_storefronts ADD CONSTRAINT shop_storefronts_access_check
  CHECK (access_mode IN ('open','password','coming_soon') AND (access_mode <> 'password' OR access_password_hash IS NOT NULL)
    AND (coming_soon_message IS NULL OR char_length(coming_soon_message) <= 500)) NOT VALID;
ALTER TABLE shop_storefronts VALIDATE CONSTRAINT shop_storefronts_access_check;
GRANT UPDATE (access_mode, access_password_hash, coming_soon_message) ON shop_storefronts TO bodhinox_app;

-- ================================================================ digital delivery ledger kind
ALTER TABLE order_notice_templates DROP CONSTRAINT order_notice_templates_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_notice_templates ADD CONSTRAINT order_notice_templates_kind_check
  CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase','abandoned_cart','cod_confirm','back_in_stock','review_request','digital_delivery')) NOT VALID;
ALTER TABLE order_notice_templates VALIDATE CONSTRAINT order_notice_templates_kind_check;
ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('checkout_link','payment_link','receipt',
  'dispatched','delivered','feedback','product_follow_up','repeat_purchase','cod_confirm','review_request','digital_delivery')) NOT VALID;
ALTER TABLE order_messages VALIDATE CONSTRAINT order_messages_kind_check;

-- ================================================================ shared read rules
-- A product shows in the shop when it is published and now is inside its optional publish_at / hide_at window.
CREATE FUNCTION shop_product_live(p_status text, p_publish_at timestamptz, p_hide_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_status = 'published' AND (p_publish_at IS NULL OR p_publish_at <= now()) AND (p_hide_at IS NULL OR p_hide_at > now())
$$;

-- The most units of a variant a buyer can take now (null = no limit). A bundle: what its scarcest part allows
-- (a bundle with no parts or an archived part sells nothing). A pre-order variant: what is left of its cap.
-- Otherwise tracked stock (on hand minus reserved), or null for a made-to-order variant.
CREATE FUNCTION shop_variant_availability(p_account uuid, p_variant uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p.is_bundle THEN
      CASE WHEN NOT EXISTS (SELECT 1 FROM shop_bundle_parts b WHERE b.account_id=p_account AND b.product_id=p.id) THEN 0
      ELSE (SELECT min(CASE WHEN pv.archived_at IS NOT NULL THEN 0
                            WHEN pv.track_inventory THEN floor(greatest(COALESCE(pl.on_hand - pl.reserved, 0), 0)::numeric / b.quantity)::int END)
            FROM shop_bundle_parts b
            JOIN shop_variants pv ON pv.account_id=b.account_id AND pv.id=b.part_variant_id
            LEFT JOIN inventory_levels pl ON pl.account_id=pv.account_id AND pl.variant_id=pv.id
            WHERE b.account_id=p_account AND b.product_id=p.id) END
    WHEN v.preorder THEN
      CASE WHEN v.preorder_cap IS NULL THEN NULL
      ELSE greatest(v.preorder_cap - COALESCE((SELECT sum(i.quantity) FROM order_items i
          JOIN orders o ON o.account_id=i.account_id AND o.id=i.order_id
          WHERE i.account_id=p_account AND i.variant_id=v.id AND i.preorder_ship_date IS NOT NULL
            AND o.status NOT IN ('expired','cancelled') AND o.refund_state <> 'full'), 0), 0)::int END
    WHEN v.track_inventory THEN greatest(COALESCE(l.on_hand - l.reserved, 0), 0)
  END
  FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
  LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
  WHERE v.account_id=p_account AND v.id=p_variant
$$;
