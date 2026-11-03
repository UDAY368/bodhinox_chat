-- Phase 8 wiring: the storefront token lookup, the storefront plan feature,
-- the new notification types and flow node. All additive: each redefined
-- CHECK is a superset that keeps every existing value.

-- ================================================================ public lookup
-- The only cross-tenant lookup the public storefront needs. A session is live
-- until it expires or is revoked; once it has placed an order it stays
-- viewable (status and receipt) for 7 days after the order was priced.
CREATE FUNCTION resolve_storefront_token(p_hash text)
RETURNS TABLE(account_id uuid, session_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id, s.id FROM storefront_sessions s
  WHERE s.token_hash = p_hash AND s.revoked_at IS NULL
    AND (s.expires_at > now() OR (s.order_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM orders o WHERE o.account_id = s.account_id AND o.id = s.order_id
        AND o.priced_at > now() - interval '7 days')))
$$;
REVOKE ALL ON FUNCTION resolve_storefront_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_storefront_token(text) TO bodhinox_worker;

-- FORCE RLS applies to the definer's owner too (pattern 20261106100500_appointments_wiring).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['storefront_sessions','orders']
  LOOP
    EXECUTE format('CREATE POLICY storefront_migration_owner ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;

-- ================================================================ notifications
-- Superset of 20261106100500_appointments_wiring.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'low_stock', 'payment_exception'));

-- ================================================================ flow node
-- Superset of 20261106100500_appointments_wiring.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link',
  'ai_reply',
  'conversion_event',
  'book_appointment',
  'send_storefront_link'));

-- ================================================================ plans
-- The storefront, checkout and paid appointments on every plan, as appointments were.
UPDATE plans SET features = features || '{"storefront":true}'::jsonb
  WHERE id IN ('free','basic','pro','enterprise');

-- ================================================================ payment reconcile sweep
-- The workspaces the worker's reconcile sweep must look at: links that may
-- still take (or took, unseen) money, links paid in the last 30 days, and
-- refunds without a final outcome. Returns account ids only.
CREATE FUNCTION crm_accounts_for_payment_reconcile() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT l.account_id FROM payment_links l
  WHERE l.status IN ('creating','unknown','created','partially_paid')
     OR (l.status='paid' AND l.updated_at > now() - interval '30 days')
  UNION
  SELECT r.account_id FROM customer_refunds r WHERE r.status IN ('requested','sending','pending','unknown')
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_payment_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_payment_reconcile() TO bodhinox_worker;

-- FORCE RLS applies to the definer's owner too (pattern above).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payment_links','customer_refunds'] LOOP
    EXECUTE format('CREATE POLICY payments_reconcile_owner ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;
