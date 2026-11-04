-- Phase 11: replaced by idx_conversations_wa_contact_number (WhatsApp rows) and
-- idx_conversations_ig_contact_account (Instagram rows), both built before this
-- runs. Kept, it would make an Instagram conversation (whatsapp_config_id NULL)
-- collide with a contact's unnumbered WhatsApp conversation.
--
-- Single statement: DROP INDEX CONCURRENTLY cannot run inside a transaction
-- block. It takes no lock that blocks conversation inserts. If interrupted,
-- re-run it (the index is either still there or gone).
DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_account_contact_number;
