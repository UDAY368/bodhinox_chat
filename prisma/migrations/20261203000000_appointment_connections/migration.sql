SET LOCAL lock_timeout = '5s';

-- Batch 3: appointments connected to the rest of the product. All additive:
-- nullable columns, NOT VALID foreign keys and checks (validated in
-- 20261203000500_appointment_connections_validate), superset checks.

-- ------------------------------------------------------------------ appointments
-- deal_id:            the deal this booking belongs to (staff-set; a completed booking can move it).
-- broadcast_id:       the campaign that produced the booking (a campaign link click before it was confirmed).
-- ad_referral_id:     the ad click that produced the booking (latest ad referral before it was confirmed).
-- conversation_id:    the chat the booking was made or confirmed in (WhatsApp or Instagram), so replies
--                     and the payment link go back on the same channel.
-- attendance_confirmed_at: the customer tapped "Confirm" on a reminder.
ALTER TABLE appointments ADD COLUMN deal_id uuid;
ALTER TABLE appointments ADD COLUMN broadcast_id uuid;
ALTER TABLE appointments ADD COLUMN ad_referral_id uuid;
ALTER TABLE appointments ADD COLUMN conversation_id uuid;
ALTER TABLE appointments ADD COLUMN attendance_confirmed_at timestamptz;
ALTER TABLE appointments ADD CONSTRAINT appointments_deal_fk
  FOREIGN KEY (account_id, deal_id) REFERENCES deals (account_id, id) ON DELETE SET NULL (deal_id) NOT VALID;
ALTER TABLE appointments ADD CONSTRAINT appointments_broadcast_fk
  FOREIGN KEY (account_id, broadcast_id) REFERENCES broadcasts (account_id, id) ON DELETE SET NULL (broadcast_id) NOT VALID;
ALTER TABLE appointments ADD CONSTRAINT appointments_ad_referral_fk
  FOREIGN KEY (account_id, ad_referral_id) REFERENCES ad_referrals (account_id, id) ON DELETE SET NULL (ad_referral_id) NOT VALID;
ALTER TABLE appointments ADD CONSTRAINT appointments_conversation_fk
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;
-- Staff link and unlink a deal; attribution, conversation and attendance are written by the worker only.
GRANT UPDATE (deal_id) ON appointments TO bodhinox_app;

-- ------------------------------------------------------------------ services
-- An intake form (WhatsApp form) sent to the customer once a booking of this service is confirmed.
ALTER TABLE appointment_services ADD COLUMN intake_form_id uuid;
ALTER TABLE appointment_services ADD CONSTRAINT appointment_services_intake_form_fk
  FOREIGN KEY (account_id, intake_form_id) REFERENCES whatsapp_forms (account_id, id) ON DELETE SET NULL (intake_form_id) NOT VALID;
GRANT UPDATE (intake_form_id) ON appointment_services TO bodhinox_app;

-- ------------------------------------------------------------------ settings
-- When a booking linked to a deal is marked completed, move that deal to this stage
-- (only when the stage is in the deal's own pipeline). NULL = leave deals alone.
ALTER TABLE appointment_settings ADD COLUMN completed_deal_stage_id uuid;
ALTER TABLE appointment_settings ADD CONSTRAINT appointment_settings_completed_stage_fk
  FOREIGN KEY (account_id, completed_deal_stage_id) REFERENCES pipeline_stages (account_id, id)
  ON DELETE SET NULL (completed_deal_stage_id) NOT VALID;
GRANT UPDATE (completed_deal_stage_id) ON appointment_settings TO bodhinox_app;

-- ------------------------------------------------------------------ history and messages
-- Superset of 20261108100000_meeting_integration (events) and 20261107102000_paid_appointments (messages).
ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_kind_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_kind_check CHECK (kind IN ('held','confirmed','rescheduled',
  'reassigned','cancelled','expired','completed','no_show','feedback','reminder_skipped',
  'payment_pending','payment_captured','late_payment',
  'meeting_created','meeting_updated','meeting_deleted','meeting_sync_failed','meeting_joined_provider',
  'attendance_confirmed','deal_linked','deal_unlinked','refund_requested')) NOT VALID;

ALTER TABLE appointment_messages DROP CONSTRAINT appointment_messages_kind_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_kind_check CHECK (kind IN ('confirmation','reminder_24h',
  'reminder_2h','cancelled','rescheduled','feedback','rebook','payment_link','intake_form')) NOT VALID;
-- The channel a customer message went out on (NULL = WhatsApp, as before).
ALTER TABLE appointment_messages ADD COLUMN channel text;
ALTER TABLE appointment_messages ADD CONSTRAINT appointment_messages_channel_check
  CHECK (channel IS NULL OR channel IN ('whatsapp','instagram')) NOT VALID;

-- ------------------------------------------------------------------ notifications
-- Supersets of 20261116090000_webhook_delivery_log plus appointment_no_show.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'low_stock', 'payment_exception', 'instagram_account_health', 'automation_notice',
    'webhook_disabled', 'appointment_no_show')) NOT VALID;

ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_event_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'automation_notice',
    'webhook_disabled', 'appointment_no_show')) NOT VALID;

ALTER TABLE notification_email_queue DROP CONSTRAINT notification_email_queue_event_check; -- additive-exception: replaced in this statement pair by a superset check, NOT VALID
ALTER TABLE notification_email_queue ADD CONSTRAINT notification_email_queue_event_check
  CHECK (event IN ('assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'number_quality',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled', 'automation_notice',
    'webhook_disabled', 'appointment_no_show')) NOT VALID;
