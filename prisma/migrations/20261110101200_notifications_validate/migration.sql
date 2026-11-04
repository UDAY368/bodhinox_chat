-- Phase 12: validate the constraint 20261110101100_notifications_notice_type
-- added NOT VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE, so
-- notifications keep being written during the scan. Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_check;
