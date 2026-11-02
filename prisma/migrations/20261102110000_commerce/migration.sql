-- Phase 6: commerce foundation. WhatsApp catalogues and products, orders placed
-- in WhatsApp or a connected store, Razorpay payment links, and store-event rules
-- that send a template when a store reports an order or an abandoned checkout.
-- All additive. Store connections (Shopify, WooCommerce) are separate migrations.
--
-- Inbound webhook idempotency for Razorpay/Shopify/WooCommerce reuses the
-- existing worker-only webhook_receipts table (provider + globally unique
-- dedupe_key), so no new receipt table is added here.

-- ---------------------------------------------------------------------------
-- WhatsApp catalogues linked to a number. catalog_id is Meta's id.
CREATE TABLE whatsapp_catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_config_id uuid,
  catalog_id text NOT NULL CHECK (catalog_id ~ '^[0-9]{1,32}$'),
  name text NOT NULL DEFAULT '' CHECK (char_length(name) <= 200),
  is_cart_enabled boolean NOT NULL DEFAULT true,
  is_catalog_visible boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  sync_error text CHECK (char_length(sync_error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, catalog_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id)
    ON DELETE SET NULL (whatsapp_config_id)
);
CREATE INDEX whatsapp_catalogs_number_idx ON whatsapp_catalogs(account_id, whatsapp_config_id);
ALTER TABLE whatsapp_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_catalogs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON whatsapp_catalogs FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON whatsapp_catalogs FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON whatsapp_catalogs FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_catalogs TO bodhinox_app,bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Products mirrored from a catalogue. Prices are integer minor units.
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  catalog_row_id uuid NOT NULL,
  retailer_id text NOT NULL CHECK (char_length(retailer_id) BETWEEN 1 AND 200),
  meta_product_id text CHECK (char_length(meta_product_id) <= 64),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 500),
  description text CHECK (char_length(description) <= 10000),
  price_minor bigint CHECK (price_minor >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  image_url text CHECK (char_length(image_url) <= 2048),
  url text CHECK (char_length(url) <= 2048),
  availability text CHECK (char_length(availability) <= 40),
  is_hidden boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, catalog_row_id, retailer_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, catalog_row_id) REFERENCES whatsapp_catalogs(account_id, id) ON DELETE CASCADE
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON products FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON products FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON products FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON products TO bodhinox_app,bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Orders: a WhatsApp cart (one per inbound message id) or a store order (one per
-- source + store order id). Inserted by the worker only; agents change status.
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('whatsapp','shopify','woocommerce','manual')),
  external_id text CHECK (char_length(external_id) BETWEEN 1 AND 200),
  message_id text CHECK (char_length(message_id) BETWEEN 1 AND 256),
  contact_id uuid,
  conversation_id uuid,
  whatsapp_config_id uuid,
  catalog_id text CHECK (char_length(catalog_id) <= 32),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  total_minor bigint CHECK (total_minor >= 0),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','confirmed','awaiting_payment','paid','fulfilled','cancelled')),
  note text CHECK (char_length(note) <= 2000),
  customer_note text CHECK (char_length(customer_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id),
  UNIQUE (account_id, source, external_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id)
    ON DELETE SET NULL (whatsapp_config_id)
);
CREATE INDEX orders_account_created_idx ON orders(account_id, created_at DESC);
CREATE INDEX orders_contact_idx ON orders(account_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX orders_conversation_idx ON orders(account_id, conversation_id) WHERE conversation_id IS NOT NULL;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON orders FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_update ON orders FOR UPDATE TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_insert ON orders FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON orders TO bodhinox_app;
-- Agents move an order through its statuses and keep an internal note; amounts,
-- items and the customer are fixed by the source.
GRANT UPDATE (status, note) ON orders TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE ON orders TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  retailer_id text CHECK (char_length(retailer_id) <= 200),
  name text CHECK (char_length(name) <= 500),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 100000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE CASCADE
);
CREATE INDEX order_items_order_idx ON order_items(account_id, order_id);
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON order_items FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_insert ON order_items FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id=app_account_id());
GRANT SELECT ON order_items TO bodhinox_app;
GRANT SELECT,INSERT ON order_items TO bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Payment provider credentials. Secrets are stored encrypted
-- (lib/whatsapp/encryption) and the app role cannot read the secret columns at
-- all: column grants expose only id/provider/mode/key_id/connected_at. Server
-- code that needs the secrets reads them through the worker role.
CREATE TABLE payment_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  mode text NOT NULL CHECK (mode IN ('test','live')),
  key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 100),
  key_secret_enc text NOT NULL CHECK (char_length(key_secret_enc) <= 4096),
  webhook_secret_enc text CHECK (char_length(webhook_secret_enc) <= 4096),
  connected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider),
  UNIQUE (account_id, id)
);
ALTER TABLE payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON payment_providers FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON payment_providers FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT (id, account_id, provider, mode, key_id, connected_at) ON payment_providers TO bodhinox_app;
GRANT INSERT, UPDATE, DELETE ON payment_providers TO bodhinox_app;
GRANT SELECT ON payment_providers TO bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Payment links. reference_id is our random idempotency key, sent to Razorpay so
-- a retried create returns the same link. 'unknown' means the create outcome was
-- ambiguous and must be reconciled (fetch by reference), never re-created.
-- Only the worker role updates a link, so 'paid' is set only by a verified
-- provider event or a reconciliation fetch, never by a browser request.
CREATE TABLE payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('razorpay')),
  provider_link_id text CHECK (char_length(provider_link_id) BETWEEN 1 AND 64),
  reference_id text NOT NULL UNIQUE CHECK (reference_id ~ '^[A-Za-z0-9_-]{16,40}$'),
  short_url text CHECK (char_length(short_url) <= 500),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description text CHECK (char_length(description) <= 2048),
  contact_id uuid,
  conversation_id uuid,
  order_id uuid,
  flow_run_id uuid,
  node_key text CHECK (char_length(node_key) <= 200),
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating','created','paid','partially_paid','expired','cancelled','failed','unknown')),
  paid_at timestamptz,
  expires_at timestamptz,
  last_event_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, order_id) REFERENCES orders(account_id, id) ON DELETE SET NULL (order_id),
  FOREIGN KEY (account_id, flow_run_id) REFERENCES flow_runs(account_id, id) ON DELETE SET NULL (flow_run_id)
);
CREATE UNIQUE INDEX payment_links_provider_link_key ON payment_links(account_id, provider, provider_link_id)
  WHERE provider_link_id IS NOT NULL;
CREATE INDEX payment_links_account_created_idx ON payment_links(account_id, created_at DESC);
CREATE INDEX payment_links_conversation_idx ON payment_links(account_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX payment_links_order_idx ON payment_links(account_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX payment_links_run_idx ON payment_links(account_id, flow_run_id) WHERE flow_run_id IS NOT NULL;
CREATE INDEX payment_links_open_idx ON payment_links(account_id, status) WHERE status IN ('creating','created','partially_paid','unknown');
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON payment_links FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_insert ON payment_links FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_update ON payment_links FOR UPDATE TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT,INSERT ON payment_links TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE ON payment_links TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Store-event rules: which template to send for which store event, from which
-- number, after how long, and which event field fills each template variable.
CREATE TABLE commerce_event_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('shopify','woocommerce')),
  event text NOT NULL CHECK (event IN ('order_created','order_paid','order_fulfilled','order_cancelled','checkout_abandoned')),
  enabled boolean NOT NULL DEFAULT false,
  template_name text NOT NULL CHECK (char_length(template_name) BETWEEN 1 AND 512),
  template_language text CHECK (char_length(template_language) <= 15),
  whatsapp_config_id uuid,
  delay_minutes integer NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 10080),
  -- {"1": "order_number", "2": "total"}: template variable index -> event field.
  variable_map jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variable_map) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source, event),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config(account_id, id)
    ON DELETE SET NULL (whatsapp_config_id)
);
ALTER TABLE commerce_event_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_event_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON commerce_event_rules FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON commerce_event_rules FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE,DELETE ON commerce_event_rules TO bodhinox_app;
GRANT SELECT ON commerce_event_rules TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON commerce_event_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One row per store event, once per dedupe key; payload holds only the flat
-- fields a rule may map into a template (lib/commerce/event-rules).
CREATE TABLE commerce_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('shopify','woocommerce')),
  event text NOT NULL CHECK (event IN ('order_created','order_paid','order_fulfilled','order_cancelled','checkout_abandoned')),
  external_id text CHECK (char_length(external_id) <= 200),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16384),
  contact_id uuid,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','scheduled','sent','skipped','failed')),
  reason text CHECK (char_length(reason) <= 200),
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dedupe_key),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id)
);
CREATE INDEX commerce_events_account_created_idx ON commerce_events(account_id, created_at DESC);
CREATE INDEX commerce_events_checkout_idx ON commerce_events(account_id, source, (payload->>'checkout_token'))
  WHERE payload ? 'checkout_token';
ALTER TABLE commerce_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON commerce_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY worker_write ON commerce_events FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON commerce_events TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE ON commerce_events TO bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Flow builder: commerce nodes, the order trigger and their run events.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link'));

ALTER TABLE flows DROP CONSTRAINT IF EXISTS flows_trigger_type_check;
ALTER TABLE flows ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN ('keyword', 'first_inbound_message', 'manual', 'template_reply', 'order_received'));

ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set',
  'api_request','flow_connected','agent_assigned',
  'form_sent','form_submitted',
  'payment_link_sent','payment_received','payment_expired','order_received'));
