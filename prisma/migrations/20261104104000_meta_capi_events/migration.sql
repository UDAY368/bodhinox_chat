-- Phase 10: Conversions API events for click-to-WhatsApp ads. An event row and
-- its meta.capi_event job are written in the same transaction as the business
-- change that caused them (payment, order, form submission, flow node), so the
-- enqueue is durable. The worker sends through an outbound intent; an
-- ambiguous outcome becomes 'unknown' and waits for an admin to record what
-- happened. It is never re-sent automatically. The click id is not copied
-- here: the worker reads it through ad_referral_id at send time. Additive.

CREATE TABLE capi_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid,
  event_name text NOT NULL CHECK (event_name IN ('Purchase','LeadSubmitted','QualifiedLead','InitiateCheckout','AddToCart','ViewContent','OrderCreated')),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (source IN ('payment_link','order','form','flow')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 200),
  contact_id uuid,
  ad_referral_id uuid,
  -- Six fraction digits: three-decimal currencies (KWD, BHD, OMR) keep their exact value.
  value numeric(18,6) CHECK (value >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  event_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','unknown','skipped')),
  skip_reason text CHECK (skip_reason IN ('disabled','no_connection','missing_scope','no_dataset','wrong_waba')),
  -- Meta code[:subcode] only, never a message body.
  last_error_code text CHECK (last_error_code ~ '^[0-9:]{0,32}$'),
  -- Meta throttles: each one re-schedules the send minutes later, a bounded number of times.
  throttle_count integer NOT NULL DEFAULT 0 CHECK (throttle_count BETWEEN 0 AND 10),
  sent_at timestamptz,
  resolution text CHECK (resolution IN ('confirmed_sent','confirmed_not_sent')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, event_id),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, connection_id) REFERENCES meta_ad_connections(account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, ad_referral_id) REFERENCES ad_referrals(account_id, id) ON DELETE SET NULL (ad_referral_id),
  CHECK (resolution IS NULL OR status = 'unknown')
);
-- Empty new table: plain indexes are safe here.
CREATE INDEX capi_events_review ON capi_events(account_id, status, created_at DESC);

ALTER TABLE capi_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE capi_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON capi_events FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- updateOrder runs in the member's app-role transaction, so an agent may queue
-- an event (never set its outcome).
CREATE POLICY app_enqueue ON capi_events FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND status = 'queued');
-- An admin records the outcome of an 'unknown' event once.
CREATE POLICY app_resolve ON capi_events FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'unknown' AND resolution IS NULL)
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'unknown'
    AND resolution IS NOT NULL AND resolved_by = app_user_id());
CREATE POLICY worker_write ON capi_events FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON capi_events TO bodhinox_app;
GRANT INSERT (account_id, connection_id, event_name, event_id, source, source_id, contact_id, ad_referral_id, value, currency, event_time)
  ON capi_events TO bodhinox_app;
GRANT UPDATE (resolution, resolved_by, resolved_at) ON capi_events TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON capi_events TO bodhinox_worker;

-- Flow builder: the conversion_event node and its run events.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link',
  'ai_reply',
  'conversion_event'));

ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set',
  'api_request','flow_connected','agent_assigned',
  'form_sent','form_submitted',
  'payment_link_sent','payment_received','payment_expired','order_received',
  'ai_replied','ai_handoff',
  'conversion_queued','ad_click'));
