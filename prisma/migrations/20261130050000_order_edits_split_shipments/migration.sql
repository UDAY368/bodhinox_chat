SET LOCAL lock_timeout = '5s';

-- Store Phase 5, package 5: edit an order before dispatch, and split shipments. Additive.
-- orders.edit_version: optimistic concurrency for order edits (the editor sends the version it read).
-- order_edits: one row per staff edit, with the lines and totals before and after, who, why, and what
--   happened to the payment difference (a balance payment link, or refunds). The id is derived from
--   the member's request id, so a replay finds its row and never refunds or links twice.
-- shipment_items: which order lines and quantities a courier shipment carries. A shipment with no
--   rows (made before this migration) carries the whole order.
-- orders.status gains 'partially_shipped': some parcels left, others have not.
-- The priced freeze stays for every role and every statement except the order-edit service, which
-- runs on the worker connection and names the one order it edits in app.order_edit for its transaction.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261130050000_order_edits_split_shipments.

-- ================================================================ orders
ALTER TABLE orders ADD COLUMN edit_version integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD CONSTRAINT orders_edit_version_check CHECK (edit_version >= 0) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_edit_version_check;

ALTER TABLE orders DROP CONSTRAINT orders_status_check; -- additive-exception: replaced in the next statement by a wider check that still admits every existing status
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('new','confirmed','awaiting_payment','payment_review','paid','partially_shipped','dispatched','fulfilled','expired','cancelled')) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_status_check;

-- True only inside the order-edit service's transaction, for the order it names.
CREATE FUNCTION order_edit_open(p_order uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_user = 'bodhinox_worker' AND COALESCE(NULLIF(current_setting('app.order_edit', true), '') = p_order::text, false)
$$;

-- CREATE OR REPLACE FUNCTION takes no table lock; the existing triggers call the new bodies.
-- An order edit may change the amounts; the currency, tax mode, coupon, address, payment method and
-- priced_at stay frozen for everyone.
CREATE OR REPLACE FUNCTION orders_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (
      NEW.priced_at IS DISTINCT FROM OLD.priced_at OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.tax_inclusive IS DISTINCT FROM OLD.tax_inclusive
      OR NEW.coupon_code IS DISTINCT FROM OLD.coupon_code OR NEW.shipping_address IS DISTINCT FROM OLD.shipping_address
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.priced_at IS NOT NULL AND (
      NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
      OR NEW.shipping_minor IS DISTINCT FROM OLD.shipping_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.cod_fee_minor IS DISTINCT FROM OLD.cod_fee_minor
      OR NEW.auto_discount_minor IS DISTINCT FROM OLD.auto_discount_minor
      OR NEW.discount_details IS DISTINCT FROM OLD.discount_details
      OR NEW.edit_version IS DISTINCT FROM OLD.edit_version)
      AND NOT order_edit_open(OLD.id) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- An order edit may change a line's quantity and the amounts that follow from it; what the line is
-- (product, name, unit price, tax rate, HSN, SKU) stays frozen.
CREATE OR REPLACE FUNCTION order_items_priced_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.account_id = OLD.account_id AND o.id = OLD.order_id AND o.priced_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.retailer_id IS DISTINCT FROM OLD.retailer_id
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.submitted_unit_price_minor IS DISTINCT FROM OLD.submitted_unit_price_minor
      OR NEW.tax_rate_bps IS DISTINCT FROM OLD.tax_rate_bps
      OR NEW.hsn_code IS DISTINCT FROM OLD.hsn_code OR NEW.sku IS DISTINCT FROM OLD.sku THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.quantity IS DISTINCT FROM OLD.quantity OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
      OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR NEW.line_total_minor IS DISTINCT FROM OLD.line_total_minor)
      AND NOT order_edit_open(OLD.order_id) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- The worker may now delete an order line, but only a line of the order being edited (or of an
-- order that was never priced). Other roles are unchanged: they hold no DELETE on the table.
CREATE FUNCTION order_items_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'bodhinox_worker' AND NOT order_edit_open(OLD.order_id)
      AND EXISTS (SELECT 1 FROM orders o WHERE o.account_id = OLD.account_id AND o.id = OLD.order_id AND o.priced_at IS NOT NULL) THEN
    RAISE EXCEPTION 'order_priced_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER order_items_delete_guard BEFORE DELETE ON order_items -- additive-exception: a brief catalogue lock under the 5 s lock_timeout; the trigger only narrows the DELETE the worker is granted just below
  FOR EACH ROW EXECUTE FUNCTION order_items_delete_guard();
CREATE POLICY worker_delete ON order_items FOR DELETE TO bodhinox_worker USING (account_id=app_account_id()); -- additive-exception: a brief catalogue lock under the 5 s lock_timeout; it adds a DELETE policy for the worker and changes no existing policy
GRANT DELETE ON order_items TO bodhinox_worker;

-- A priced order reaches partially shipped, dispatched or delivered only once paid, except a
-- cash-on-delivery order, which ships from confirmed before its cash arrives. A browser session
-- never sets partially shipped: it follows from the shipments.
CREATE OR REPLACE FUNCTION orders_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'bodhinox_app' AND (NEW.status IN ('paid','payment_review','expired','partially_shipped')
      OR OLD.status IN ('payment_review','expired')) THEN
    RAISE EXCEPTION 'order_status_forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.priced_at IS NOT NULL AND NEW.status IN ('partially_shipped','dispatched','fulfilled')
      AND OLD.status NOT IN ('paid','partially_shipped','dispatched')
      AND NOT (NEW.payment_method = 'cod' AND OLD.status = 'confirmed') THEN
    RAISE EXCEPTION 'order_not_paid' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ order_edits
CREATE TABLE order_edits (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  -- [{"variant_id","sku","name","quantity","unit_price_minor","line_total_minor"}]: product names, ids and amounts only.
  lines_before jsonb NOT NULL CHECK (jsonb_typeof(lines_before) = 'array' AND pg_column_size(lines_before) <= 65536),
  lines_after jsonb NOT NULL CHECK (jsonb_typeof(lines_after) = 'array' AND pg_column_size(lines_after) <= 65536),
  -- {"subtotal_minor","discount_minor","shipping_minor","cod_fee_minor","tax_minor","total_minor"}
  totals_before jsonb NOT NULL CHECK (jsonb_typeof(totals_before) = 'object' AND pg_column_size(totals_before) <= 2048),
  totals_after jsonb NOT NULL CHECK (jsonb_typeof(totals_after) = 'object' AND pg_column_size(totals_after) <= 2048),
  total_before_minor bigint NOT NULL CHECK (total_before_minor >= 0),
  total_after_minor bigint NOT NULL CHECK (total_after_minor >= 0),
  -- none: nothing paid yet (or no difference); collect: paid online, the new total is higher; refund: it is lower.
  payment_action text NOT NULL CHECK (payment_action IN ('none','collect','refund')),
  difference_minor bigint NOT NULL DEFAULT 0 CHECK (difference_minor >= 0),
  payment_state text NOT NULL CHECK (payment_state IN
    ('none','link_pending','link_created','link_failed','link_unknown','link_paid','refund_requested','refund_outside')),
  payment_link_id uuid,
  refund_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(refund_ids) <= 20),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,64}$'),
  version_after integer NOT NULL CHECK (version_after > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  CHECK ((payment_action = 'none') = (payment_state = 'none')),
  CHECK (payment_action <> 'none' OR difference_minor = 0)
);
CREATE INDEX order_edits_order_idx ON order_edits (account_id, order_id, created_at);
ALTER TABLE order_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON order_edits FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON order_edits FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON order_edits TO bodhinox_app;
GRANT SELECT, INSERT ON order_edits TO bodhinox_worker;
-- The audit columns are written once; only the payment outcome moves afterwards.
GRANT UPDATE (payment_state, payment_link_id, failure_code, updated_at) ON order_edits TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_edits FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ split shipments
-- An order may now have several live shipments. The server keeps the shipped quantity of every line
-- within the ordered quantity, under the order's row lock (every shipment write locks the order first).
DROP INDEX order_shipments_live_order_key; -- additive-exception: the one-live-shipment-per-order rule is replaced by the per-line quantity check in lib/fulfilment/shipments.ts; a plain index on the same columns follows
CREATE INDEX order_shipments_order_idx ON order_shipments (account_id, order_id); -- additive-exception: order_shipments holds a few rows per shipped order, the build is brief and takes a write lock only for that moment

CREATE TABLE shipment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, shipment_id, order_item_id),
  FOREIGN KEY (account_id, shipment_id) REFERENCES order_shipments(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, order_item_id) REFERENCES order_items(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shipment_items_order_item_idx ON shipment_items (account_id, order_item_id);
ALTER TABLE shipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shipment_items FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON shipment_items FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shipment_items TO bodhinox_app;
GRANT SELECT, INSERT ON shipment_items TO bodhinox_worker;
