-- Phase 4b: WhatsApp Forms (Meta Flows). A form is built in our editor, compiled
-- to Flow JSON and published to Meta; each send issues a one-time flow token and
-- each submission is stored once per inbound message. All additive.

CREATE TABLE whatsapp_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (category IN ('SIGN_UP', 'SIGN_IN', 'APPOINTMENT_BOOKING', 'LEAD_GENERATION',
    'CONTACT_US', 'CUSTOMER_SUPPORT', 'SURVEY', 'OTHER')),
  -- Our builder schema (lib/whatsapp/forms/types); validated before every save.
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  -- The compiled Flow JSON last uploaded to Meta.
  flow_json jsonb CHECK (flow_json IS NULL OR jsonb_typeof(flow_json) = 'object'),
  meta_flow_id text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'deprecated', 'blocked', 'throttled', 'error')),
  validation_errors jsonb CHECK (validation_errors IS NULL OR jsonb_typeof(validation_errors) = 'array'),
  preview_url text,
  uses_endpoint boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  UNIQUE (account_id, id)
);
CREATE INDEX whatsapp_forms_meta_flow_idx ON whatsapp_forms(account_id, meta_flow_id) WHERE meta_flow_id IS NOT NULL;
ALTER TABLE whatsapp_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON whatsapp_forms FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
-- Admins author and publish forms; the worker only reads them to send.
CREATE POLICY tenant_write ON whatsapp_forms FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE,DELETE ON whatsapp_forms TO bodhinox_app;
GRANT SELECT ON whatsapp_forms TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_forms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- One row per form send. The flow token is random and single-use; it ties the
-- customer's submission back to the form, contact and (optionally) flow run.
CREATE TABLE whatsapp_form_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  flow_token text NOT NULL UNIQUE CHECK (flow_token ~ '^[A-Za-z0-9_-]{43,200}$'),
  form_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  flow_run_id uuid,
  node_key text CHECK (char_length(node_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, form_id) REFERENCES whatsapp_forms(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, flow_run_id) REFERENCES flow_runs(account_id, id) ON DELETE SET NULL (flow_run_id)
);
CREATE INDEX whatsapp_form_sessions_form_idx ON whatsapp_form_sessions(account_id, form_id, created_at);
CREATE INDEX whatsapp_form_sessions_run_idx ON whatsapp_form_sessions(account_id, flow_run_id) WHERE flow_run_id IS NOT NULL;
ALTER TABLE whatsapp_form_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_form_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON whatsapp_form_sessions FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
-- Agents send forms from the inbox; the worker sends them from flows and records completion.
CREATE POLICY tenant_insert ON whatsapp_form_sessions FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY tenant_update ON whatsapp_form_sessions FOR UPDATE TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT,UPDATE ON whatsapp_form_sessions TO bodhinox_app,bodhinox_worker;

-- Submitted answers. The inbound message id makes a redelivered webhook a no-op.
CREATE TABLE whatsapp_form_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  form_id uuid,
  session_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id text NOT NULL CHECK (char_length(message_id) BETWEEN 1 AND 256),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, form_id) REFERENCES whatsapp_forms(account_id, id) ON DELETE SET NULL (form_id),
  FOREIGN KEY (account_id, session_id) REFERENCES whatsapp_form_sessions(account_id, id) ON DELETE SET NULL (session_id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX whatsapp_form_responses_form_idx ON whatsapp_form_responses(account_id, form_id, created_at);
CREATE INDEX whatsapp_form_responses_contact_idx ON whatsapp_form_responses(account_id, contact_id) WHERE contact_id IS NOT NULL;
ALTER TABLE whatsapp_form_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_form_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON whatsapp_form_responses FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_insert ON whatsapp_form_responses FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT ON whatsapp_form_responses TO bodhinox_app,bodhinox_worker;

-- Flow messages are end-to-end encrypted with a per-number RSA key pair. The
-- private key is stored encrypted (lib/whatsapp/encryption) and neither column is
-- ever part of a browser resource.
ALTER TABLE whatsapp_config ADD COLUMN forms_public_key TEXT
  CONSTRAINT whatsapp_config_forms_public_key_check CHECK (forms_public_key IS NULL OR char_length(forms_public_key) <= 8192);
ALTER TABLE whatsapp_config ADD COLUMN forms_private_key_enc TEXT;
ALTER TABLE whatsapp_config ADD COLUMN forms_key_uploaded_at TIMESTAMPTZ;

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form'));

ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set',
  'api_request','flow_connected','agent_assigned',
  'form_sent','form_submitted'));
