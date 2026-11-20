SET LOCAL lock_timeout = '5s';

-- Validate what 20261203000000_appointment_connections added NOT VALID (the new columns are NULL;
-- the superset checks accept every existing row).
ALTER TABLE appointments VALIDATE CONSTRAINT appointments_deal_fk;
ALTER TABLE appointments VALIDATE CONSTRAINT appointments_broadcast_fk;
ALTER TABLE appointments VALIDATE CONSTRAINT appointments_ad_referral_fk;
ALTER TABLE appointments VALIDATE CONSTRAINT appointments_conversation_fk;
ALTER TABLE appointment_services VALIDATE CONSTRAINT appointment_services_intake_form_fk;
ALTER TABLE appointment_settings VALIDATE CONSTRAINT appointment_settings_completed_stage_fk;
ALTER TABLE appointment_events VALIDATE CONSTRAINT appointment_events_kind_check;
ALTER TABLE appointment_messages VALIDATE CONSTRAINT appointment_messages_kind_check;
ALTER TABLE appointment_messages VALIDATE CONSTRAINT appointment_messages_channel_check;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_check;
ALTER TABLE notification_preferences VALIDATE CONSTRAINT notification_preferences_event_check;
ALTER TABLE notification_email_queue VALIDATE CONSTRAINT notification_email_queue_event_check;
