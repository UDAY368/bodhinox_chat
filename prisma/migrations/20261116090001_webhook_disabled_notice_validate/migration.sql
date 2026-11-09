-- Validate the notifications type check 20261116090000_webhook_delivery_log
-- added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE, so
-- notifications keep being written during the scan. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_check;
