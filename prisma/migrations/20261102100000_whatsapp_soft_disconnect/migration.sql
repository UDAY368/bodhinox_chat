-- Disconnecting a WhatsApp number keeps its row.
--
-- Additive: no table or column changes. Disconnecting now marks the row
-- status 'disconnected' with access_token cleared to '' instead of deleting it
-- (deleting set its conversations to "no number", which collided with the
-- NULLS NOT DISTINCT conversation index and re-routed threads to the default).
-- A disconnected row is never the default, so "the first number becomes the
-- default" now means "a number connected while the workspace has no default
-- becomes the default", on insert and when a disconnected row is reconnected in
-- place (its token set again by the manual connect or Embedded Signup).
-- Existing workspaces always have a default when they have any row, so this
-- changes nothing for them.

CREATE OR REPLACE FUNCTION whatsapp_config_first_is_default() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT NEW.is_default AND NEW.access_token <> '' AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config w WHERE w.account_id = NEW.account_id AND w.is_default AND w.id <> NEW.id
  ) THEN
    NEW.is_default := TRUE;
  END IF;
  RETURN NEW;
END $$;

-- Runs as the updating role under tenant RLS, like the insert trigger.
CREATE TRIGGER whatsapp_config_reconnect_is_default BEFORE UPDATE OF access_token ON whatsapp_config
  FOR EACH ROW WHEN (OLD.access_token = '' AND NEW.access_token <> '')
  EXECUTE FUNCTION whatsapp_config_first_is_default();
