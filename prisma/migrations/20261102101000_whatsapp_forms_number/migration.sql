-- A WhatsApp form belongs to one number and that number's WABA: its Meta Flow
-- is created and published in that WABA, it is only sent from numbers of that
-- WABA, and its data endpoint only accepts requests decrypted with a key of a
-- number in that WABA.
--
-- Additive. whatsapp_config_id follows the conversations/broadcasts pattern:
-- deleting the number leaves the form with no number (SET NULL) while waba_id
-- still records the WABA its Meta Flow lives in, so the form is never silently
-- moved to another WABA.
ALTER TABLE whatsapp_forms ADD COLUMN whatsapp_config_id UUID;
ALTER TABLE whatsapp_forms ADD CONSTRAINT whatsapp_forms_whatsapp_config_id_fkey
  FOREIGN KEY (account_id, whatsapp_config_id) REFERENCES whatsapp_config (account_id, id)
  ON DELETE SET NULL (whatsapp_config_id);
ALTER TABLE whatsapp_forms ADD COLUMN waba_id TEXT
  CONSTRAINT whatsapp_forms_waba_id_check CHECK (waba_id IS NULL OR char_length(waba_id) <= 64);

-- Until multi-number, a workspace had one number, which is now its default:
-- every existing form was created in that number's WABA. The backfill keeps
-- updated_at (nothing a user did changed).
ALTER TABLE whatsapp_forms DISABLE TRIGGER set_updated_at;
UPDATE whatsapp_forms f SET whatsapp_config_id = w.id,
    waba_id = CASE WHEN char_length(w.waba_id) <= 64 THEN w.waba_id END
  FROM whatsapp_config w
  WHERE w.account_id = f.account_id AND w.is_default AND f.whatsapp_config_id IS NULL;
ALTER TABLE whatsapp_forms ENABLE TRIGGER set_updated_at;

CREATE INDEX whatsapp_forms_account_number_idx ON whatsapp_forms (account_id, whatsapp_config_id);
