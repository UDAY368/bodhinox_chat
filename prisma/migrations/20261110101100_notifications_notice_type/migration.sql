-- Phase 12: the automation_notice notification type (automation step
-- notify_team). Superset of 20261109101000_conversation_channel, added NOT
-- VALID so no scan happens under this lock; 20261110101200 validates it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'low_stock', 'payment_exception', 'instagram_account_health', 'automation_notice')) NOT VALID;
