-- Phase 11: a conversation is on one channel. Every existing row is WhatsApp
-- (constant default: no table rewrite). An Instagram conversation names its
-- Instagram account and never a WhatsApp number. The conversation unique index
-- is rebuilt per channel by the three single-statement migrations that follow
-- (CONCURRENTLY), so no WhatsApp key changes. Additive.
--
-- Every constraint here is added NOT VALID and validated by
-- 20261109101400_conversation_channel_validate. This file takes ACCESS
-- EXCLUSIVE locks (ADD COLUMN, DROP/ADD CONSTRAINT), and Prisma runs a file as
-- one transaction, so a VALIDATE here would full-scan messages and
-- conversations while those locks block every read and write. The follow-up
-- file validates under SHARE UPDATE EXCLUSIVE, which lets traffic continue.

-- ================================================================ conversations
ALTER TABLE conversations ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE conversations ADD COLUMN instagram_account_id uuid;
ALTER TABLE conversations ADD CONSTRAINT conversations_instagram_account_id_fkey
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id) NOT VALID;
-- Folds the channel IN (...) check into one: WhatsApp rows never name an
-- Instagram account; Instagram rows always do and never name a WhatsApp number.
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_sender_check CHECK (
  (channel = 'whatsapp' AND instagram_account_id IS NULL)
  OR (channel = 'instagram' AND instagram_account_id IS NOT NULL AND whatsapp_config_id IS NULL)) NOT VALID;

-- The insert trigger fills the workspace default number only for WhatsApp
-- conversations (replaces 20261102090000_whatsapp_multi_number). Without this an
-- Instagram insert would get the default number and fail the check above.
CREATE OR REPLACE FUNCTION conversations_default_number() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.channel = 'whatsapp' AND NEW.whatsapp_config_id IS NULL THEN
    SELECT w.id INTO NEW.whatsapp_config_id FROM whatsapp_config w
      WHERE w.account_id = NEW.account_id AND w.is_default;
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ messages
-- Instagram story replies, shared posts/reels (URL only) and anything this
-- phase cannot show. Superset of the foundation check.
ALTER TABLE messages DROP CONSTRAINT messages_content_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN ('text','image','document','audio','video','location','template','interactive',
    'story_reply','share','unsupported')) NOT VALID;
-- An Instagram composer send whose provider outcome is ambiguous stays 'unknown'
-- ("delivery uncertain"); it is never retried or cleared automatically.
-- Superset of the foundation check.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('sending','sent','delivered','read','failed','unknown')) NOT VALID;

-- ================================================================ flows
-- Existing flows stay WhatsApp-only.
ALTER TABLE flows ADD COLUMN channel_scope text NOT NULL DEFAULT 'whatsapp';
ALTER TABLE flows ADD CONSTRAINT flows_channel_scope_check
  CHECK (channel_scope IN ('whatsapp','instagram','any')) NOT VALID;

-- ================================================================ notifications
-- Superset of 20261107102500_commerce_wiring.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing',
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'low_stock', 'payment_exception', 'instagram_account_health')) NOT VALID;
-- The Instagram account an instagram_account_health alert is about.
ALTER TABLE notifications ADD COLUMN instagram_account_id uuid;
ALTER TABLE notifications ADD CONSTRAINT notifications_instagram_account_id_fkey
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id)
  ON DELETE SET NULL (instagram_account_id) NOT VALID;
