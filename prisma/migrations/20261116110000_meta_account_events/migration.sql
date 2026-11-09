-- Meta Tech Provider obligations.
--
-- 1. account_update webhook: the latest account-level event Meta sent for a
--    number's WhatsApp Business Account (partner removed, app uninstalled,
--    account deleted, disabled, restricted, violation), so Settings can say why
--    a number stopped sending. Written by the worker only
--    (src/lib/whatsapp/account-update.ts). The detail is a fixed, short summary
--    built from Meta's enum values (violation type, restriction types, ban
--    state), never free text from the payload. Existing rows stay NULL.
-- 2. Data deletion requests: Meta's Data Deletion Request Callback
--    (POST /api/meta/data-deletion). One row per verified signed_request; the
--    Facebook user id is stored only as a SHA-256 hash. Worker role only, no
--    tenant data (allowlisted in rls-sweep.integration.test.ts like
--    webhook_receipts). The public status page reads one row by its code.
--
-- Additive: four nullable columns (all existing rows NULL, so the CHECKs hold)
-- and one new, empty table.
SET LOCAL lock_timeout = '5s';

ALTER TABLE whatsapp_config ADD COLUMN meta_account_event TEXT
  CONSTRAINT whatsapp_config_meta_account_event_check
  CHECK (meta_account_event IS NULL OR (char_length(meta_account_event) <= 64 AND meta_account_event ~ '^[A-Z_]+$'));
ALTER TABLE whatsapp_config ADD COLUMN meta_account_detail TEXT
  CONSTRAINT whatsapp_config_meta_account_detail_check
  CHECK (meta_account_detail IS NULL OR char_length(meta_account_detail) <= 300);
ALTER TABLE whatsapp_config ADD COLUMN meta_account_event_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN meta_account_until TIMESTAMPTZ;

CREATE TABLE meta_data_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  confirmation_code text NOT NULL UNIQUE CHECK (confirmation_code ~ '^[A-Za-z0-9]{20,64}$'),
  app_user_hash text NOT NULL CHECK (app_user_hash ~ '^[a-f0-9]{64}$'),
  issued_at bigint NOT NULL CHECK (issued_at >= 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('received', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Meta may deliver the same signed request again: it maps to the same code.
  UNIQUE (app_user_hash, issued_at)
);
ALTER TABLE meta_data_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_data_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_data_deletion ON meta_data_deletion_requests FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON meta_data_deletion_requests TO bodhinox_worker;
