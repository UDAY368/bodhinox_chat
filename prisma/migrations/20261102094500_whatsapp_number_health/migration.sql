-- WhatsApp number health sync and admin alerts.
--
-- Additive: the worker refreshes each connected number's Meta health every six
-- hours (quality_rating, messaging_limit_tier and name_status already exist from
-- 20261102090000_whatsapp_multi_number) and alerts the workspace's admins once
-- per change. Existing rows keep NULL health until their first sync, and a first
-- sync never alerts, so deploying this changes nothing a user sees until a real
-- change happens.

-- ---------------------------------------------------------------- numbers
ALTER TABLE whatsapp_config ADD COLUMN code_verification_status TEXT
  CONSTRAINT whatsapp_config_code_verification_status_check
  CHECK (code_verification_status IS NULL OR char_length(code_verification_status) <= 64);
-- The last failed sync as a fixed category, never Meta's message or a token.
-- Cleared by the next successful sync; health_checked_at stays the last success.
ALTER TABLE whatsapp_config ADD COLUMN health_error TEXT
  CONSTRAINT whatsapp_config_health_error_check
  CHECK (health_error IS NULL OR health_error IN ('token', 'unavailable'));
ALTER TABLE whatsapp_config ADD COLUMN health_error_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- notifications
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health'));
-- The number a health alert is about; deleting the number keeps the alert.
ALTER TABLE notifications ADD COLUMN whatsapp_config_id UUID;
ALTER TABLE notifications ADD CONSTRAINT notifications_whatsapp_config_id_fkey
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config (account_id, id)
  ON DELETE SET NULL (whatsapp_config_id);
-- One alert per recipient per observed change, even if a sync is retried.
ALTER TABLE notifications ADD COLUMN dedupe_key TEXT
  CONSTRAINT notifications_dedupe_key_check CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200);
CREATE UNIQUE INDEX notifications_account_user_dedupe_key
  ON notifications (account_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------------- scheduling
-- Fixed worker projection: which numbers to sync. Returns identifiers only, no
-- tokens. The migration_owner SELECT policy on whatsapp_config (foundation)
-- lets this definer read across tenants; the worker then reads and writes each
-- number inside that number's tenant scope.
CREATE FUNCTION crm_whatsapp_numbers_for_health_sync()
RETURNS TABLE(account_id uuid, whatsapp_config_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.account_id, w.id FROM whatsapp_config w
  WHERE w.status = 'connected' AND w.phone_number_id <> '' AND w.access_token <> ''
$$;
REVOKE ALL ON FUNCTION crm_whatsapp_numbers_for_health_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_whatsapp_numbers_for_health_sync() TO bodhinox_worker;
