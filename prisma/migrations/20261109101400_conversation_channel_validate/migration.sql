-- Phase 11: validate the constraints 20261109101000_conversation_channel added
-- NOT VALID. Nothing in this file takes an ACCESS EXCLUSIVE lock: VALIDATE
-- CONSTRAINT holds SHARE UPDATE EXCLUSIVE on the table it scans (plus ROW
-- SHARE on a foreign key's referenced table), so WhatsApp message ingest,
-- sends and inbox reads continue during the scans. New rows were already
-- checked from the moment each constraint was added. Additive.
ALTER TABLE conversations VALIDATE CONSTRAINT conversations_instagram_account_id_fkey;
ALTER TABLE conversations VALIDATE CONSTRAINT conversations_channel_sender_check;
ALTER TABLE messages VALIDATE CONSTRAINT messages_content_type_check;
ALTER TABLE messages VALIDATE CONSTRAINT messages_status_check;
ALTER TABLE flows VALIDATE CONSTRAINT flows_channel_scope_check;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_type_check;
ALTER TABLE notifications VALIDATE CONSTRAINT notifications_instagram_account_id_fkey;
