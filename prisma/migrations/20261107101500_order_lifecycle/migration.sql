-- Phase 8: order lifecycle. Append-only order history, returns, tax documents
-- with gap-free numbers per workspace and financial year, and the customer
-- message ledger for order notices. Additive.

-- ================================================================ history (append-only)
CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  -- status_changed, priced, reserved, released, payment_captured, late_payment_restocked,
  -- coupon_over_limit, refund_*, return_*, dispatched, delivered, feedback, document_issued,
  -- note, ... (a lower-case code; the services own the list).
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  from_status text,
  to_status text,
  actor text NOT NULL CHECK (actor IN ('staff','customer','system')),
  actor_user_id uuid,
  -- A code only, never customer content.
  detail text CHECK (detail IS NULL OR detail ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE
);
CREATE INDEX order_events_order_idx ON order_events (account_id, order_id, created_at);
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON order_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
-- The app role inserts only through the status-history trigger, as the signed-in member.
CREATE POLICY app_status_insert ON order_events FOR INSERT TO bodhinox_app
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent') AND kind='status_changed'
    AND actor='staff' AND actor_user_id IS NOT NULL AND actor_user_id = app_user_id());
CREATE POLICY worker_insert ON order_events FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT, INSERT ON order_events TO bodhinox_app;
GRANT SELECT, INSERT ON order_events TO bodhinox_worker;

-- Every status change is recorded. Staff when app.user_id is set (a browser
-- session, or a worker-run staff service that set it), otherwise the system.
CREATE FUNCTION orders_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
BEGIN
  INSERT INTO order_events(account_id, order_id, kind, from_status, to_status, actor, actor_user_id)
  VALUES (NEW.account_id, NEW.id, 'status_changed', OLD.status, NEW.status,
    CASE WHEN actor_id IS NULL THEN 'system' ELSE 'staff' END, actor_id);
  RETURN NULL;
END $$;
CREATE TRIGGER orders_status_history AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION orders_status_history();

-- ================================================================ returns
CREATE TABLE order_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  -- [{"order_item_id": "...", "qty": n}]
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 100
    AND pg_column_size(items) <= 8192),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','received','inspected','closed','rejected')),
  -- {"<order_item_id>": "restock" | "discard"}
  disposition jsonb CHECK (disposition IS NULL OR (jsonb_typeof(disposition) = 'object' AND pg_column_size(disposition) <= 8192)),
  refund_id uuid,
  note text CHECK (note IS NULL OR char_length(note) <= 500),
  restocked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, refund_id) REFERENCES customer_refunds(account_id, id) ON DELETE SET NULL (refund_id)
);
CREATE INDEX order_returns_order_idx ON order_returns (account_id, order_id);
CREATE INDEX order_returns_status_idx ON order_returns (account_id, status, created_at DESC);

ALTER TABLE customer_refunds ADD CONSTRAINT customer_refunds_return_fkey FOREIGN KEY (account_id, return_id)
  REFERENCES order_returns(account_id, id) ON DELETE SET NULL (return_id);
-- One refund per return: two concurrent "refund this return" requests cannot both insert (a failed one is retried in place).
CREATE UNIQUE INDEX customer_refunds_return_key ON customer_refunds (account_id, return_id) WHERE return_id IS NOT NULL;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_return_fkey FOREIGN KEY (account_id, return_id)
  REFERENCES order_returns(account_id, id) ON DELETE SET NULL (return_id);

-- ================================================================ documents
-- Gap-free numbering: <prefix>/<FY>/<seq>, the sequence row locked FOR UPDATE.
CREATE TABLE commerce_document_sequences (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  -- Financial year April-March, e.g. 2026-27.
  fy text NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (account_id, fy)
);

CREATE TABLE commerce_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid,
  appointment_id uuid,
  payment_id uuid,
  refund_id uuid,
  -- A receipt is titled "Tax invoice" when the seller has a GSTIN.
  kind text NOT NULL CHECK (kind IN ('receipt','credit_note')),
  number text NOT NULL CHECK (number ~ '^[A-Z0-9]{1,8}/[0-9]{4}-[0-9]{2}/[0-9]{1,9}$'),
  fy text NOT NULL CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  seller jsonb NOT NULL CHECK (jsonb_typeof(seller) = 'object' AND pg_column_size(seller) <= 4096),
  buyer jsonb NOT NULL CHECK (jsonb_typeof(buyer) = 'object' AND pg_column_size(buyer) <= 4096),
  address jsonb CHECK (address IS NULL OR (jsonb_typeof(address) = 'object' AND pg_column_size(address) <= 2048)),
  line_items jsonb NOT NULL CHECK (jsonb_typeof(line_items) = 'array' AND pg_column_size(line_items) <= 65536),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  shipping_minor bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  cgst_minor bigint NOT NULL DEFAULT 0 CHECK (cgst_minor >= 0),
  sgst_minor bigint NOT NULL DEFAULT 0 CHECK (sgst_minor >= 0),
  igst_minor bigint NOT NULL DEFAULT 0 CHECK (igst_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, number),
  UNIQUE (account_id, payment_id, kind),
  UNIQUE (account_id, refund_id),
  CHECK (cgst_minor + sgst_minor + igst_minor IN (0, tax_minor)),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id),
  FOREIGN KEY (account_id, appointment_id) REFERENCES appointments(account_id, id) ON DELETE SET NULL (appointment_id),
  FOREIGN KEY (account_id, payment_id) REFERENCES customer_payments(account_id, id) ON DELETE SET NULL (payment_id),
  FOREIGN KEY (account_id, refund_id) REFERENCES customer_refunds(account_id, id) ON DELETE SET NULL (refund_id)
);
CREATE INDEX commerce_documents_order_idx ON commerce_documents (account_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX commerce_documents_issued_idx ON commerce_documents (account_id, issued_at DESC);

-- ================================================================ customer message outcomes
-- Same shape as appointment_messages: one row per order and notice kind.
CREATE TABLE order_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkout_link','payment_link','receipt','dispatched','delivered','feedback','product_follow_up')),
  status text NOT NULL CHECK (status IN ('sent','skipped','blocked','failed','outcome_unknown')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z0-9_]{1,64}$'),
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, order_id, kind),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE
);
CREATE INDEX order_messages_open_idx ON order_messages (account_id, created_at)
  WHERE status IN ('blocked','failed','outcome_unknown') AND resolved_at IS NULL;

-- ================================================================ RLS
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['order_returns','commerce_document_sequences','commerce_documents','order_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO bodhinox_app,bodhinox_worker USING (account_id=app_account_id() AND app_write_allowed(%L))', t, 'agent');
    EXECUTE format('CREATE POLICY worker_write ON %I FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO bodhinox_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bodhinox_worker', t);
  END LOOP;
END $$;
-- Documents are immutable once issued (no UPDATE for anyone).
REVOKE UPDATE ON commerce_documents FROM bodhinox_worker;
-- Admins mark a blocked/failed/unknown notice resolved.
CREATE POLICY admin_resolve ON order_messages FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT UPDATE (resolved_at, resolved_by) ON order_messages TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_returns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_messages FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
