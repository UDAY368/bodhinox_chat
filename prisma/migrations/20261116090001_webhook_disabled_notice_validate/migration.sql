-- Validate the notifications type and notification_preferences /
-- notification_email_queue event checks 20261116090000_webhook_delivery_log
-- added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE, so
-- notifications keep being written during the scan. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_check;
ALTER TABLE notification_preferences VALIDATE CONSTRAINT notification_preferences_event_check;
ALTER TABLE notification_email_queue VALIDATE CONSTRAINT notification_email_queue_event_check;
