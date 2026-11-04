-- Phase 11: the WhatsApp conversation key, now scoped to WhatsApp rows. Same
-- columns and NULLS NOT DISTINCT as idx_conversations_account_contact_number
-- (20261102090000_whatsapp_multi_number), so a workspace with no number (or a
-- deleted one) still keeps one unnumbered WhatsApp conversation per contact.
-- Instagram rows (whatsapp_config_id NULL) are keyed by
-- idx_conversations_ig_contact_account instead. The old index is dropped only
-- after both exist (20261109101300), so the guard is never missing.
--
-- This file holds a single statement on purpose: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. If a deploy is interrupted mid-build,
-- PostgreSQL leaves an INVALID index; drop it (DROP INDEX CONCURRENTLY
-- idx_conversations_wa_contact_number) and mark the migration rolled back
-- (prisma migrate resolve --rolled-back 20261109101100_conversations_wa_index)
-- before re-running.
CREATE UNIQUE INDEX CONCURRENTLY idx_conversations_wa_contact_number
  ON conversations (account_id, contact_id, whatsapp_config_id) NULLS NOT DISTINCT WHERE channel = 'whatsapp';
