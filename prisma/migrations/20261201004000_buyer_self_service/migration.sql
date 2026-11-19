SET LOCAL lock_timeout = '5s';

-- Store plan Phase 8, batch 5: buyer self-service. Additive.
-- shop_buyer_settings: one row per workspace, written by admins only. Switches for buyer return requests and
--   price-drop nudges, and the checkout extras the shop offers (order note, gift message, delivery date with lead
--   days, delivery time slots, up to five custom fields). The caps are fixed here as well as in the server.
-- order_returns: a buyer's request from the order page is a return with source 'buyer'. It waits for staff to
--   approve it (approved_at); the stock and refund flow after that is the one staff returns already use. A buyer
--   request carries its reason code, the contact who made it, the request id the page sent (a replay finds the same
--   return), and for an exchange the replacement variant per line; approving an exchange makes the replacement
--   order through the manual-order path (exchange_order_id).
-- orders.buyer_extras / storefront_sessions.extras: what the buyer typed at checkout (note, gift message,
--   delivery date and slot, custom field answers). Not part of pricing; the order keeps the labels it was placed with.
-- shop_wishlist_items: a contact's saved variants (the contact is the one the shop session identifies).
-- shop_price_drops / shop_price_nudges: a variant price drop and the one nudge each wishlisted contact can get for
--   it. The drop job is queued by the trigger below, in the transaction that changes the price, whichever code
--   path changed it. A nudge row is the dedupe: one per drop and contact.
-- order_notice_templates.kind: the new notice kind 'price_drop' (an approved MARKETING template for the message
--   outside the 24-hour window); the CHECK is rebuilt as a superset of 20261201002000_selling_options.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261201004000_buyer_self_service.

-- ================================================================ settings
CREATE TABLE shop_buyer_settings (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  buyer_returns_enabled boolean NOT NULL DEFAULT false,
  price_drop_nudges_enabled boolean NOT NULL DEFAULT false,
  note_enabled boolean NOT NULL DEFAULT false,
  gift_message_enabled boolean NOT NULL DEFAULT false,
  delivery_date_enabled boolean NOT NULL DEFAULT false,
  lead_days integer NOT NULL DEFAULT 1 CHECK (lead_days BETWEEN 0 AND 60),
  window_days integer NOT NULL DEFAULT 14 CHECK (window_days BETWEEN 1 AND 60),
  -- [{"id": "am", "label": "9am - 12pm"}], at most 6
  slots jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) <= 6
    AND pg_column_size(slots) <= 2048),
  -- [{"id": "g1", "label": "Gift wrap", "type": "checkbox", "required": false, "options": []}], at most 5
  custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(custom_fields) = 'array' AND jsonb_array_length(custom_fields) <= 5
    AND pg_column_size(custom_fields) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shop_buyer_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shop_buyer_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shop_buyer_settings FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON shop_buyer_settings FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON shop_buyer_settings TO bodhinox_worker;
GRANT SELECT, INSERT ON shop_buyer_settings TO bodhinox_app;
GRANT UPDATE (buyer_returns_enabled, price_drop_nudges_enabled, note_enabled, gift_message_enabled, delivery_date_enabled,
  lead_days, window_days, slots, custom_fields, updated_at) ON shop_buyer_settings TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shop_buyer_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ returns
ALTER TABLE order_returns ADD COLUMN source text NOT NULL DEFAULT 'staff';
ALTER TABLE order_returns ADD COLUMN reason text;
ALTER TABLE order_returns ADD COLUMN contact_id uuid;
ALTER TABLE order_returns ADD COLUMN client_request_id uuid;
-- {"<order_item_id>": "<wanted replacement variant id>"}
ALTER TABLE order_returns ADD COLUMN exchange jsonb;
ALTER TABLE order_returns ADD COLUMN approved_at timestamptz;
ALTER TABLE order_returns ADD COLUMN approved_by uuid;
ALTER TABLE order_returns ADD COLUMN exchange_order_id uuid;
ALTER TABLE order_returns ADD CONSTRAINT order_returns_buyer_check CHECK (
  source IN ('staff','buyer')
  AND (reason IS NULL OR reason IN ('wrong_item','damaged','not_as_described','size_fit','changed_mind','other'))
  AND (source = 'staff' OR (client_request_id IS NOT NULL AND reason IS NOT NULL))
  AND (exchange IS NULL OR (jsonb_typeof(exchange) = 'object' AND pg_column_size(exchange) <= 4096))) NOT VALID;
ALTER TABLE order_returns VALIDATE CONSTRAINT order_returns_buyer_check;
ALTER TABLE order_returns ADD CONSTRAINT order_returns_contact_fkey FOREIGN KEY (account_id, contact_id)
  REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id) NOT VALID; -- the column is new and empty: nothing to check; validate in a later migration
ALTER TABLE order_returns ADD CONSTRAINT order_returns_exchange_order_fkey FOREIGN KEY (account_id, exchange_order_id)
  REFERENCES orders(account_id, id) ON DELETE SET NULL (exchange_order_id) NOT VALID; -- the column is new and empty: nothing to check; validate in a later migration
-- A replayed request from the order page finds the return it already made.
CREATE UNIQUE INDEX order_returns_buyer_request_key ON order_returns (account_id, order_id, client_request_id)
  WHERE client_request_id IS NOT NULL; -- additive-exception: order_returns is small and the partial index covers no existing row; held only for the brief build under lock_timeout

-- ================================================================ checkout extras
ALTER TABLE orders ADD COLUMN buyer_extras jsonb;
ALTER TABLE orders ADD CONSTRAINT orders_buyer_extras_check
  CHECK (buyer_extras IS NULL OR (jsonb_typeof(buyer_extras) = 'object' AND pg_column_size(buyer_extras) <= 4096)) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_buyer_extras_check;
ALTER TABLE storefront_sessions ADD COLUMN extras jsonb;
ALTER TABLE storefront_sessions ADD CONSTRAINT storefront_sessions_extras_check
  CHECK (extras IS NULL OR (jsonb_typeof(extras) = 'object' AND pg_column_size(extras) <= 4096)) NOT VALID;
ALTER TABLE storefront_sessions VALIDATE CONSTRAINT storefront_sessions_extras_check;

-- ================================================================ wishlist and price drops
CREATE TABLE shop_wishlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, contact_id, variant_id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_wishlist_items_variant_idx ON shop_wishlist_items (account_id, variant_id);

CREATE TABLE shop_price_drops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  from_minor bigint NOT NULL CHECK (from_minor > 0),
  to_minor bigint NOT NULL CHECK (to_minor >= 0),
  -- The queued job's dedupe key: a replayed job finds this drop again.
  source_key text NOT NULL CHECK (char_length(source_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, source_key),
  FOREIGN KEY (account_id, variant_id) REFERENCES shop_variants(account_id, id) ON DELETE CASCADE
);

CREATE TABLE shop_price_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  drop_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  -- pending: claimed, the send not settled yet (the next run asks dispatchOnce again, never a second message);
  -- sent; closed: nothing was or will be sent (reason holds a code, never customer content).
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','closed')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- At most one nudge per contact for one drop.
  UNIQUE (account_id, drop_id, contact_id),
  FOREIGN KEY (account_id, drop_id) REFERENCES shop_price_drops(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shop_price_nudges_contact_idx ON shop_price_nudges (account_id, contact_id, variant_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['shop_wishlist_items','shop_price_drops','shop_price_nudges']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;

-- The price-drop job, queued in the transaction that lowers a variant's price when someone has it on a wishlist.
-- SECURITY INVOKER (as queue_catalog_push): the app role may insert jobs for its own tenant only.
CREATE FUNCTION queue_price_drop() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_key text;
BEGIN
  IF EXISTS (SELECT 1 FROM shop_wishlist_items w WHERE w.account_id = NEW.account_id AND w.variant_id = NEW.id) THEN
    v_key := 'price-drop:' || NEW.id::text || ':' || OLD.price_minor::text || ':' || NEW.price_minor::text || ':' || txid_current()::text;
    INSERT INTO jobs(type, tenant_id, payload, dedupe_key)
    VALUES ('commerce.price_drop', NEW.account_id,
      jsonb_build_object('variantId', NEW.id::text, 'fromMinor', OLD.price_minor, 'toMinor', NEW.price_minor, 'key', v_key), v_key)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER shop_variants_price_drop AFTER UPDATE OF price_minor ON shop_variants
  FOR EACH ROW WHEN (OLD.price_minor IS NOT NULL AND NEW.price_minor IS NOT NULL AND NEW.price_minor < OLD.price_minor)
  EXECUTE FUNCTION queue_price_drop(); -- additive-exception: catalogue-only metadata change (brief lock, bounded by lock_timeout); queues a job, never blocks or rewrites rows

-- ================================================================ notice kind
ALTER TABLE order_notice_templates DROP CONSTRAINT order_notice_templates_kind_check; -- additive-exception: replaced below by a superset
ALTER TABLE order_notice_templates ADD CONSTRAINT order_notice_templates_kind_check
  CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase','abandoned_cart','cod_confirm','back_in_stock','review_request','digital_delivery','price_drop')) NOT VALID;
ALTER TABLE order_notice_templates VALIDATE CONSTRAINT order_notice_templates_kind_check;
