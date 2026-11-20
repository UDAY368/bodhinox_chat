-- Standardisation batch 5, item 1: the event feed (docs/superpowers/plans/2026-11-19-standardisation-master-workflow.md, section 5).
--
-- domain_events: one short record per business event, written in the transaction of the
--   change itself, either by emit_domain_event() (called from src/lib/events/emit.ts) or by
--   the triggers below for orders, returns, payments, deals and form answers, so every code
--   path that changes those rows is covered. Each new event queues one 'events.dispatch' job
--   in the same transaction; the worker fans it out once to rules, flows and webhooks.
--   outbox_events stays the 7-day realtime row-change log the browser streams; it has no
--   contact column and is pruned too early for a contact timeline.
-- data holds ids, codes and amounts only (never message text, answers, phones or addresses).
SET LOCAL lock_timeout = '5s';

CREATE TABLE domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_]+$' AND char_length(type) <= 64),
  subject_kind text NOT NULL CHECK (subject_kind ~ '^[a-z_]+$' AND char_length(subject_kind) <= 32),
  subject_id uuid NOT NULL,
  contact_id uuid,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 4096),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX domain_events_dedupe_idx ON domain_events (account_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- The contact timeline, newest first, a page at a time.
CREATE INDEX domain_events_contact_idx ON domain_events (account_id, contact_id, occurred_at DESC, id DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX domain_events_subject_idx ON domain_events (account_id, subject_kind, subject_id, occurred_at);
CREATE INDEX domain_events_occurred_idx ON domain_events (account_id, occurred_at);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON domain_events FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id = app_account_id());
-- Inserted only through emit_domain_event() and the triggers, in the transaction of a change
-- that already passed its own table's checks; the account is always the caller's own.
CREATE POLICY tenant_insert ON domain_events FOR INSERT TO bodhinox_app,bodhinox_worker
  WITH CHECK (account_id = app_account_id());
-- Retention and contact erasure (worker only).
CREATE POLICY worker_delete ON domain_events FOR DELETE TO bodhinox_worker
  USING (account_id = app_account_id());
GRANT SELECT, INSERT ON domain_events TO bodhinox_app;
GRANT SELECT, INSERT, DELETE ON domain_events TO bodhinox_worker;

-- Records the event (once per dedupe key) and queues its dispatch job. SECURITY INVOKER: the
-- caller's tenant policies apply, so it can only write the caller's own workspace.
CREATE FUNCTION emit_domain_event(
  p_account uuid, p_type text, p_kind text, p_subject uuid, p_contact uuid, p_data jsonb, p_dedupe text
) RETURNS TABLE (event_id uuid, created boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO domain_events (account_id, type, subject_kind, subject_id, contact_id, data, dedupe_key)
  VALUES (p_account, p_type, p_kind, p_subject, p_contact, COALESCE(p_data, '{}'::jsonb), p_dedupe)
  ON CONFLICT (account_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING domain_events.id INTO v_id;
  IF v_id IS NULL THEN
    SELECT d.id INTO v_id FROM domain_events d WHERE d.account_id = p_account AND d.dedupe_key = p_dedupe;
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;
  INSERT INTO jobs (type, tenant_id, payload, dedupe_key)
  VALUES ('events.dispatch', p_account, jsonb_build_object('eventId', v_id), 'domain-event:' || v_id::text)
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN QUERY SELECT v_id, true;
END $$;
REVOKE ALL ON FUNCTION emit_domain_event(uuid,text,text,uuid,uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION emit_domain_event(uuid,text,text,uuid,uuid,jsonb,text) TO bodhinox_app,bodhinox_worker;

-- ---------------------------------------------------------------- orders
CREATE FUNCTION domain_events_orders() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE
  v_data jsonb;
  v_type text;
BEGIN
  v_data := jsonb_build_object(
    'order_id', NEW.id, 'source', NEW.source, 'status', NEW.status,
    'from_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    'total_minor', COALESCE(NEW.total_minor, NEW.subtotal_minor), 'currency', NEW.currency,
    'conversation_id', NEW.conversation_id);
  IF TG_OP = 'INSERT' THEN
    PERFORM emit_domain_event(NEW.account_id, 'order.created', 'order', NEW.id, NEW.contact_id, v_data, 'order:' || NEW.id || ':created');
    IF NEW.status = 'paid' THEN
      PERFORM emit_domain_event(NEW.account_id, 'order.paid', 'order', NEW.id, NEW.contact_id, v_data, 'order:' || NEW.id || ':paid');
    END IF;
    RETURN NULL;
  END IF;
  v_type := CASE
    WHEN NEW.status = 'paid' THEN 'order.paid'
    WHEN NEW.status IN ('partially_shipped','dispatched') AND OLD.status NOT IN ('partially_shipped','dispatched') THEN 'order.shipped'
    WHEN NEW.status = 'fulfilled' THEN 'order.delivered'
  END;
  IF v_type IS NOT NULL THEN
    -- Once per order and kind: a status that is left and re-entered does not fire twice.
    PERFORM emit_domain_event(NEW.account_id, v_type, 'order', NEW.id, NEW.contact_id, v_data,
      'order:' || NEW.id || ':' || split_part(v_type, '.', 2));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain_events_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_events_orders() TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER orders_domain_events_insert AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION domain_events_orders(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows
CREATE TRIGGER orders_domain_events_status AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION domain_events_orders(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows

-- ---------------------------------------------------------------- returns received back
CREATE FUNCTION domain_events_order_returns() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_contact uuid;
BEGIN
  IF NEW.status <> 'received' OR (TG_OP = 'UPDATE' AND OLD.status = 'received') THEN RETURN NULL; END IF;
  SELECT o.contact_id INTO v_contact FROM orders o WHERE o.account_id = NEW.account_id AND o.id = NEW.order_id;
  PERFORM emit_domain_event(NEW.account_id, 'order.returned', 'order_return', NEW.id, v_contact,
    jsonb_build_object('order_id', NEW.order_id, 'return_id', NEW.id), 'order-return:' || NEW.id || ':received');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain_events_order_returns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_events_order_returns() TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER order_returns_domain_events AFTER INSERT OR UPDATE OF status ON order_returns
  FOR EACH ROW EXECUTE FUNCTION domain_events_order_returns(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows

-- ---------------------------------------------------------------- payments captured
CREATE FUNCTION domain_events_customer_payments() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_contact uuid;
BEGIN
  IF NEW.status <> 'captured' OR (TG_OP = 'UPDATE' AND OLD.status = 'captured') THEN RETURN NULL; END IF;
  SELECT COALESCE(
    (SELECT o.contact_id FROM orders o WHERE o.account_id = NEW.account_id AND o.id = NEW.order_id),
    (SELECT l.contact_id FROM payment_links l WHERE l.account_id = NEW.account_id AND l.id = NEW.payment_link_id),
    (SELECT a.contact_id FROM appointments a WHERE a.account_id = NEW.account_id AND a.id = NEW.appointment_id))
  INTO v_contact;
  PERFORM emit_domain_event(NEW.account_id, 'payment.received', 'payment', NEW.id, v_contact,
    jsonb_build_object('payment_id', NEW.id, 'order_id', NEW.order_id, 'payment_link_id', NEW.payment_link_id,
      'appointment_id', NEW.appointment_id, 'amount_minor', NEW.amount_minor, 'currency', NEW.currency,
      'source', NEW.source, 'method', NEW.method),
    'payment:' || NEW.id || ':received');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain_events_customer_payments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_events_customer_payments() TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER customer_payments_domain_events AFTER INSERT OR UPDATE OF status ON customer_payments
  FOR EACH ROW EXECUTE FUNCTION domain_events_customer_payments(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows

-- ---------------------------------------------------------------- deal stage moves
CREATE FUNCTION domain_events_deals() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_stage text;
BEGIN
  SELECT s.name INTO v_stage FROM pipeline_stages s WHERE s.account_id = NEW.account_id AND s.id = NEW.stage_id;
  -- No dedupe key: a deal can move back and forth, and each move is its own event.
  PERFORM emit_domain_event(NEW.account_id, 'deal.stage_changed', 'deal', NEW.id, NEW.contact_id,
    jsonb_build_object('deal_id', NEW.id, 'pipeline_id', NEW.pipeline_id, 'from_stage_id', OLD.stage_id,
      'to_stage_id', NEW.stage_id, 'stage_name', left(v_stage, 80), 'value', NEW.value, 'currency', NEW.currency),
    NULL);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain_events_deals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_events_deals() TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER deals_domain_events AFTER UPDATE OF stage_id ON deals
  FOR EACH ROW WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id)
  EXECUTE FUNCTION domain_events_deals(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows

-- ---------------------------------------------------------------- form answers
CREATE FUNCTION domain_events_form_responses() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  -- Ids only: the answers stay in whatsapp_form_responses.
  PERFORM emit_domain_event(NEW.account_id, 'form.submitted', 'form_response', NEW.id, NEW.contact_id,
    jsonb_build_object('form_id', NEW.form_id, 'response_id', NEW.id, 'conversation_id', NEW.conversation_id),
    'form-response:' || NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION domain_events_form_responses() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_events_form_responses() TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER whatsapp_form_responses_domain_events AFTER INSERT ON whatsapp_form_responses
  FOR EACH ROW EXECUTE FUNCTION domain_events_form_responses(); -- additive-exception: event-feed trigger (brief lock, bounded by lock_timeout); writes an event and a job, never blocks or rewrites rows
