-- Payment notifications: agents get an in-app alert when a payment link they
-- created (or one on a conversation assigned to them) is paid. Replaces the
-- type CHECK with a superset; a later migration that replaces it again must
-- keep every value listed here.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received'));
