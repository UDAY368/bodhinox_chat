-- Several WhatsApp numbers per workspace, possibly in different WABAs.
--
-- Additive and behaviour-preserving for every existing workspace: each one
-- has at most one whatsapp_config row today (UNIQUE(account_id)), so that row
-- becomes the workspace default and every existing conversation and broadcast
-- is stamped with it. phone_number_id stays globally unique
-- (whatsapp_config_phone_number_id_key), so an inbound webhook still routes to
-- exactly one number and one workspace.

-- ---------------------------------------------------------------- numbers
ALTER TABLE whatsapp_config ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_config ADD COLUMN display_name TEXT
  CONSTRAINT whatsapp_config_display_name_check CHECK (display_name IS NULL OR char_length(display_name) <= 200);
ALTER TABLE whatsapp_config ADD COLUMN quality_rating TEXT
  CONSTRAINT whatsapp_config_quality_rating_check CHECK (quality_rating IS NULL OR char_length(quality_rating) <= 32);
ALTER TABLE whatsapp_config ADD COLUMN messaging_limit_tier TEXT
  CONSTRAINT whatsapp_config_messaging_limit_tier_check CHECK (messaging_limit_tier IS NULL OR char_length(messaging_limit_tier) <= 64);
ALTER TABLE whatsapp_config ADD COLUMN name_status TEXT
  CONSTRAINT whatsapp_config_name_status_check CHECK (name_status IS NULL OR char_length(name_status) <= 64);
ALTER TABLE whatsapp_config ADD COLUMN health_checked_at TIMESTAMPTZ;

-- The single existing number of each workspace is its default. Backfills keep
-- updated_at and emit no realtime/outbox events: nothing a user did changed.
ALTER TABLE whatsapp_config DISABLE TRIGGER set_updated_at;
UPDATE whatsapp_config SET is_default = TRUE;
ALTER TABLE whatsapp_config ENABLE TRIGGER set_updated_at;

ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_account_id_phone_number_id_key UNIQUE (account_id, phone_number_id);
ALTER TABLE whatsapp_config DROP CONSTRAINT whatsapp_config_account_id_key;
CREATE UNIQUE INDEX whatsapp_config_one_default_per_account ON whatsapp_config (account_id) WHERE is_default;
CREATE INDEX whatsapp_config_waba_idx ON whatsapp_config (waba_id) WHERE waba_id IS NOT NULL;

-- The first number a workspace connects becomes its default, so the existing
-- single-number connect flow keeps producing a default without knowing about it.
-- Runs as the inserting role: tenant RLS limits the probe to that workspace.
CREATE FUNCTION whatsapp_config_first_is_default() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT NEW.is_default AND NOT EXISTS (SELECT 1 FROM whatsapp_config w WHERE w.account_id = NEW.account_id) THEN
    NEW.is_default := TRUE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_config_first_is_default BEFORE INSERT ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_config_first_is_default();

-- ---------------------------------------------------------------- conversations
-- One conversation per (contact, number). A conversation keeps its number;
-- deleting the number leaves the history with no number rather than deleting it.
ALTER TABLE conversations ADD COLUMN whatsapp_config_id UUID;
ALTER TABLE conversations ADD CONSTRAINT conversations_whatsapp_config_id_fkey
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config (account_id, id)
  ON DELETE SET NULL (whatsapp_config_id);
ALTER TABLE conversations DISABLE TRIGGER set_updated_at;
ALTER TABLE conversations DISABLE TRIGGER domain_outbox;
UPDATE conversations c SET whatsapp_config_id = w.id
  FROM whatsapp_config w WHERE w.account_id = c.account_id AND c.whatsapp_config_id IS NULL;
ALTER TABLE conversations ENABLE TRIGGER domain_outbox;
ALTER TABLE conversations ENABLE TRIGGER set_updated_at;
-- Replaces idx_conversations_account_contact. NULLS NOT DISTINCT keeps a
-- workspace with no number (or a deleted one) at one unnumbered conversation per
-- contact, exactly as before.
CREATE UNIQUE INDEX idx_conversations_account_contact_number
  ON conversations (account_id, contact_id, whatsapp_config_id) NULLS NOT DISTINCT;
DROP INDEX idx_conversations_account_contact;
CREATE INDEX idx_conversations_account_number ON conversations (account_id, whatsapp_config_id);

-- Code paths that create a conversation without naming a number (outbound
-- sends, scheduled audiences, the public API) get the workspace default — the
-- number they send from. Runs as the inserting role under tenant RLS.
CREATE FUNCTION conversations_default_number() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.whatsapp_config_id IS NULL THEN
    SELECT w.id INTO NEW.whatsapp_config_id FROM whatsapp_config w
      WHERE w.account_id = NEW.account_id AND w.is_default;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_default_number BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_default_number();

-- ---------------------------------------------------------------- broadcasts
-- The number a campaign sends from; NULL means the workspace default.
ALTER TABLE broadcasts ADD COLUMN whatsapp_config_id UUID;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_whatsapp_config_id_fkey
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config (account_id, id)
  ON DELETE SET NULL (whatsapp_config_id);
ALTER TABLE broadcasts DISABLE TRIGGER set_updated_at;
ALTER TABLE broadcasts DISABLE TRIGGER domain_outbox;
UPDATE broadcasts b SET whatsapp_config_id = w.id
  FROM whatsapp_config w WHERE w.account_id = b.account_id AND b.whatsapp_config_id IS NULL;
ALTER TABLE broadcasts ENABLE TRIGGER domain_outbox;
ALTER TABLE broadcasts ENABLE TRIGGER set_updated_at;
CREATE INDEX idx_broadcasts_account_number ON broadcasts (account_id, whatsapp_config_id);

-- ---------------------------------------------------------------- flows
-- The number a flow triggers on; NULL means every number (today's behaviour).
ALTER TABLE flows ADD COLUMN whatsapp_config_id UUID;
ALTER TABLE flows ADD CONSTRAINT flows_whatsapp_config_id_fkey
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config (account_id, id)
  ON DELETE SET NULL (whatsapp_config_id);
CREATE INDEX idx_flows_account_number ON flows (account_id, whatsapp_config_id);

-- ---------------------------------------------------------------- templates
-- Templates belong to a WABA; template webhooks update only that WABA's rows.
ALTER TABLE message_templates ADD COLUMN waba_id TEXT
  CONSTRAINT message_templates_waba_id_check CHECK (waba_id IS NULL OR char_length(waba_id) <= 64);
ALTER TABLE message_templates DISABLE TRIGGER set_updated_at;
UPDATE message_templates t SET waba_id = w.waba_id
  FROM whatsapp_config w
  WHERE w.account_id = t.account_id AND t.waba_id IS NULL AND w.waba_id IS NOT NULL AND char_length(w.waba_id) <= 64;
ALTER TABLE message_templates ENABLE TRIGGER set_updated_at;
CREATE INDEX idx_message_templates_account_waba ON message_templates (account_id, waba_id);

REVOKE ALL ON FUNCTION whatsapp_config_first_is_default(), conversations_default_number() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION whatsapp_config_first_is_default(), conversations_default_number()
  TO bodhinox_app, bodhinox_auth, bodhinox_worker;
