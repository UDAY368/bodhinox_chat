-- Phase 7 wiring: public lookups, widened CHECK lists, plan seed. All additive:
-- each redefined CHECK is a superset that keeps every existing value.

-- ================================================================ public lookups
-- The only cross-tenant lookups the public booking and manage pages need.
CREATE FUNCTION resolve_booking_page(p_slug text)
RETURNS TABLE(account_id uuid, page_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.account_id, p.id FROM booking_pages p WHERE p.slug = p_slug AND p.active
$$;
REVOKE ALL ON FUNCTION resolve_booking_page(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_booking_page(text) TO bodhinox_worker;

CREATE FUNCTION resolve_appointment_token(p_hash text)
RETURNS TABLE(account_id uuid, appointment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.account_id, a.id FROM appointments a WHERE a.manage_token_hash = p_hash
$$;
REVOKE ALL ON FUNCTION resolve_appointment_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_appointment_token(text) TO bodhinox_worker;

-- FORCE RLS applies to the definers' owner too (pattern 20261102020000_click_token_owner_policy).
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['booking_pages','appointments']
  LOOP
    EXECUTE format('CREATE POLICY appointments_migration_owner ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;

-- ================================================================ notifications
-- Superset of 20261102133000_billing_lifecycle.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled'));

-- Superset of the inline checks in 20261102120000_inbox_premium (default names).
ALTER TABLE notification_preferences DROP CONSTRAINT IF EXISTS notification_preferences_event_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled'));
ALTER TABLE notification_email_queue DROP CONSTRAINT IF EXISTS notification_email_queue_event_check;
ALTER TABLE notification_email_queue ADD CONSTRAINT notification_email_queue_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled'));

-- ================================================================ flow node
-- Superset of 20261104104000_meta_capi_events.
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link',
  'ai_reply',
  'conversion_event',
  'book_appointment'));

-- ================================================================ plans
-- Appointments on every plan; practitioner count unlimited (JSON null) until the
-- owner sets real limits.
UPDATE plans SET features = features || '{"appointments":true}'::jsonb,
  limits = limits || '{"appointment_staff":null}'::jsonb
  WHERE id IN ('free','basic','pro','enterprise');
