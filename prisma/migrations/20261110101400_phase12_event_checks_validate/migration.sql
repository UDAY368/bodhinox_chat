-- Phase 12: validate the three CHECK constraints 20261110101300 added NOT
-- VALID. VALIDATE CONSTRAINT holds SHARE UPDATE EXCLUSIVE, so run events,
-- preferences and queued emails keep being written during the scan. CHECK
-- validation reads the heap directly, so FORCE RLS does not hide rows from it.
-- Additive.
SET LOCAL lock_timeout = '5s';
ALTER TABLE flow_run_events VALIDATE CONSTRAINT flow_run_events_event_type_check;
ALTER TABLE notification_preferences VALIDATE CONSTRAINT notification_preferences_event_check;
ALTER TABLE notification_email_queue VALIDATE CONSTRAINT notification_email_queue_event_check;
