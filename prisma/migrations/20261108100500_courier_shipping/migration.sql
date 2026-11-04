-- Phase 9: Shiprocket courier shipments, tracking evidence, order notice
-- templates and repeat-purchase consent (design §1, D2-D4, D10-D13). All
-- additive: each redefined CHECK is a superset that keeps every existing value.
--
-- Off by default: nothing here makes a provider call. A shipment exists only
-- after an admin connected Shiprocket and a member created one explicitly
-- (it spends the Shiprocket wallet).
--
-- Secrets (*_enc) are excluded from the app role's column SELECT grant; the
-- webhook token is stored only as a sha256 digest (never needed back).

-- ================================================================ connections
CREATE TABLE courier_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'shiprocket' CHECK (provider = 'shiprocket'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','token_invalid','disconnected')),
  api_email text NOT NULL CHECK (char_length(api_email) BETWEEN 3 AND 254 AND position('@' in api_email) > 1),
  api_password_enc text CHECK (api_password_enc IS NULL OR char_length(api_password_enc) <= 4096),
  token_enc text CHECK (token_enc IS NULL OR char_length(token_enc) <= 4096),
  token_expires_at timestamptz,
  webhook_token_hash text CHECK (webhook_token_hash IS NULL OR webhook_token_hash ~ '^[0-9a-f]{64}$'),
  pickup_location text CHECK (pickup_location IS NULL OR char_length(pickup_location) BETWEEN 1 AND 100),
  default_length_cm numeric(6,1) CHECK (default_length_cm IS NULL OR (default_length_cm > 0 AND default_length_cm <= 300)),
  default_breadth_cm numeric(6,1) CHECK (default_breadth_cm IS NULL OR (default_breadth_cm > 0 AND default_breadth_cm <= 300)),
  default_height_cm numeric(6,1) CHECK (default_height_cm IS NULL OR (default_height_cm > 0 AND default_height_cm <= 300)),
  default_weight_grams integer CHECK (default_weight_grams IS NULL OR default_weight_grams BETWEEN 1 AND 100000),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  connected_by uuid,
  connected_at timestamptz NOT NULL DEFAULT now(),
  disconnected_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX courier_connections_live_account_key ON courier_connections (account_id) WHERE status <> 'disconnected';
ALTER TABLE courier_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON courier_connections FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON courier_connections FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT (id, account_id, provider, status, api_email, pickup_location, default_length_cm, default_breadth_cm,
  default_height_cm, default_weight_grams, last_error_code, connected_at)
  ON courier_connections TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON courier_connections TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON courier_connections FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ shipments
-- reference is our idempotency key, sent as the Shiprocket channel order_id; an
-- ambiguous create or AWB assignment is reconciled (never repeated: a second
-- AWB assignment charges the wallet twice). Writes are worker-only.
CREATE TABLE order_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'shiprocket' CHECK (provider = 'shiprocket'),
  reference text NOT NULL CHECK (reference ~ '^bx[a-z0-9]{12}$'),
  create_state text NOT NULL DEFAULT 'creating' CHECK (create_state IN ('creating','created','unknown','failed','cancelled')),
  awb_state text NOT NULL DEFAULT 'none' CHECK (awb_state IN ('none','assigning','assigned','unknown','failed')),
  claim_token uuid,
  claimed_until timestamptz,
  sr_order_id text CHECK (sr_order_id IS NULL OR sr_order_id ~ '^[0-9]{1,20}$'),
  sr_shipment_id text CHECK (sr_shipment_id IS NULL OR sr_shipment_id ~ '^[0-9]{1,20}$'),
  awb text CHECK (awb IS NULL OR awb ~ '^[A-Za-z0-9-]{4,40}$'),
  courier_name text CHECK (courier_name IS NULL OR char_length(courier_name) <= 80),
  tracking_status text CHECK (tracking_status IS NULL OR tracking_status ~ '^[a-z_]{1,32}$'),
  tracking_rank smallint CHECK (tracking_rank IS NULL OR tracking_rank BETWEEN 0 AND 100),
  tracking_event_at timestamptz,
  provider_dispatched_at timestamptz,
  provider_delivered_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  length_cm numeric(6,1) NOT NULL CHECK (length_cm > 0 AND length_cm <= 300),
  breadth_cm numeric(6,1) NOT NULL CHECK (breadth_cm > 0 AND breadth_cm <= 300),
  height_cm numeric(6,1) NOT NULL CHECK (height_cm > 0 AND height_cm <= 300),
  weight_grams integer NOT NULL CHECK (weight_grams BETWEEN 1 AND 100000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, reference),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, connection_id) REFERENCES courier_connections(account_id, id)
);
-- One live shipment per order; an AWB belongs to one shipment per workspace.
CREATE UNIQUE INDEX order_shipments_live_order_key ON order_shipments (account_id, order_id)
  WHERE create_state NOT IN ('failed','cancelled');
CREATE UNIQUE INDEX order_shipments_awb_key ON order_shipments (account_id, awb) WHERE awb IS NOT NULL;
CREATE INDEX order_shipments_open_idx ON order_shipments (account_id, tracking_event_at)
  WHERE create_state = 'created' AND (tracking_rank IS NULL OR tracking_rank < 90);
ALTER TABLE order_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON order_shipments FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_write ON order_shipments FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT (id, account_id, order_id, connection_id, provider, reference, create_state, awb_state, claimed_until,
  sr_order_id, sr_shipment_id, awb, courier_name, tracking_status, tracking_rank, tracking_event_at,
  provider_dispatched_at, provider_delivered_at, last_error_code, length_cm, breadth_cm, height_cm, weight_grams,
  created_by, created_at, updated_at)
  ON order_shipments TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON order_shipments TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_shipments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ tracking evidence (append-only)
-- Normalised status and the provider's code only: no location, activity text
-- or customer fields. Only data read back from Shiprocket with the workspace's
-- own credentials is stored (a push is a hint that triggers a re-fetch).
CREATE TABLE shipment_tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  status text NOT NULL CHECK (status ~ '^[a-z_]{1,32}$'),
  provider_code text NOT NULL CHECK (char_length(provider_code) BETWEEN 1 AND 40),
  event_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('refetch','poll','create')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, shipment_id, provider_code, event_at),
  FOREIGN KEY (account_id, shipment_id) REFERENCES order_shipments(account_id, id) ON DELETE CASCADE
);
CREATE INDEX shipment_tracking_events_shipment_idx ON shipment_tracking_events (account_id, shipment_id, event_at);
ALTER TABLE shipment_tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_tracking_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shipment_tracking_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_insert ON shipment_tracking_events FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shipment_tracking_events TO bodhinox_app;
GRANT SELECT, INSERT ON shipment_tracking_events TO bodhinox_worker;

-- ================================================================ exceptions
-- Opened by the worker; admins resolve them (accept a correction, dismiss, recreate, manual).
CREATE TABLE shipment_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  shipment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('contradiction','create_unknown','awb_unknown','rto','lost_or_damaged','stale_tracking','order_conflict')),
  observed_status text CHECK (observed_status IS NULL OR observed_status ~ '^[a-z_]{1,32}$'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('accept_correction','dismiss','recreate','manual')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK ((status = 'open') = (resolution IS NULL)),
  FOREIGN KEY (account_id, shipment_id) REFERENCES order_shipments(account_id, id) ON DELETE CASCADE
);
-- One open exception per shipment, kind and observed status (a second contradiction with another status is its own row).
CREATE UNIQUE INDEX shipment_exceptions_open_key ON shipment_exceptions (account_id, shipment_id, kind, (COALESCE(observed_status, '')))
  WHERE status = 'open';
CREATE INDEX shipment_exceptions_open_idx ON shipment_exceptions (account_id, created_at) WHERE status = 'open';
ALTER TABLE shipment_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON shipment_exceptions FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
-- Pattern: order_messages admin_resolve (20261107101500_order_lifecycle).
CREATE POLICY admin_resolve ON shipment_exceptions FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON shipment_exceptions FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON shipment_exceptions TO bodhinox_app;
GRANT UPDATE (status, resolution, resolved_by, resolved_at, updated_at) ON shipment_exceptions TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON shipment_exceptions TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON shipment_exceptions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ order notice templates
-- The approved template per order notice kind, used outside the 24-hour window.
CREATE TABLE order_notice_templates (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('dispatched','delivered','feedback','repeat_purchase')),
  template_name text NOT NULL CHECK (char_length(template_name) BETWEEN 1 AND 512),
  language text NOT NULL CHECK (char_length(language) BETWEEN 2 AND 15),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);
ALTER TABLE order_notice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_notice_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON order_notice_templates FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_write ON order_notice_templates FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON order_notice_templates TO bodhinox_app;
GRANT SELECT ON order_notice_templates TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON order_notice_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ repeat-purchase consent (D13)
-- An explicit opt-in from an unticked checkbox at checkout; NULL = unknown
-- (nothing is sent). Set by placeOrder (worker), frozen once the order is priced.
ALTER TABLE orders ADD COLUMN marketing_opt_in boolean;
ALTER TABLE orders ADD COLUMN marketing_opt_in_at timestamptz;
ALTER TABLE orders ADD COLUMN marketing_opt_in_version text
  CHECK (marketing_opt_in_version IS NULL OR marketing_opt_in_version ~ '^[a-z0-9_]{1,32}$');

-- The WhatsApp-cart path sets these in the UPDATE that prices the order, before
-- priced_at is set, so OLD.priced_at is still NULL there.
CREATE FUNCTION orders_opt_in_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.priced_at IS NOT NULL AND (NEW.marketing_opt_in IS DISTINCT FROM OLD.marketing_opt_in
      OR NEW.marketing_opt_in_at IS DISTINCT FROM OLD.marketing_opt_in_at
      OR NEW.marketing_opt_in_version IS DISTINCT FROM OLD.marketing_opt_in_version) THEN
    RAISE EXCEPTION 'order_opt_in_frozen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_opt_in_freeze BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_opt_in_freeze();

ALTER TABLE shop_products ADD COLUMN repurchase_after_days smallint
  CHECK (repurchase_after_days IS NULL OR repurchase_after_days BETWEEN 1 AND 365);
GRANT UPDATE (repurchase_after_days) ON shop_products TO bodhinox_app;

-- Superset of 20261107101500_order_lifecycle.
ALTER TABLE order_messages DROP CONSTRAINT order_messages_kind_check;
ALTER TABLE order_messages ADD CONSTRAINT order_messages_kind_check CHECK (kind IN ('checkout_link','payment_link','receipt',
  'dispatched','delivered','feedback','product_follow_up','repeat_purchase'));
