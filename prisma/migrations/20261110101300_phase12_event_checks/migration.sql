-- Phase 12: new event values, each a superset of the previous definition and
-- added NOT VALID so no table scan happens under the ACCESS EXCLUSIVE lock
-- these statements take; 20261110101400 validates them with a lighter lock.
--  * flow_run_events: 'migrated' (a run moved to another published version)
--    and 'replayed' (an admin replayed a failed step). Superset of
--    20261104104000_meta_capi_events.
--  * notification_preferences / notification_email_queue: 'automation_notice'
--    (automation step notify_team), so members can switch it off and get the
--    email. Superset of 20261106100500_appointments_wiring.
-- Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flow_run_events DROP CONSTRAINT flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set',
  'api_request','flow_connected','agent_assigned',
  'form_sent','form_submitted',
  'payment_link_sent','payment_received','payment_expired','order_received',
  'ai_replied','ai_handoff',
  'conversion_queued','ad_click',
  'migrated','replayed')) NOT VALID;

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_event_check;
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'automation_notice')) NOT VALID;

ALTER TABLE notification_email_queue DROP CONSTRAINT notification_email_queue_event_check;
ALTER TABLE notification_email_queue ADD CONSTRAINT notification_email_queue_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'automation_notice')) NOT VALID;
