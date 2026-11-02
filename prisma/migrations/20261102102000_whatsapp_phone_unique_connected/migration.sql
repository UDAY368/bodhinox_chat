-- A WhatsApp number is held by at most one workspace at a time, counting only
-- numbers that are connected.
--
-- Disconnecting a number keeps its row (status 'disconnected', access_token
-- cleared to '') so its history stays intact. With phone_number_id globally
-- unique, that kept row blocked every other workspace from ever connecting the
-- number. The global unique index becomes a partial one over rows that are not
-- admin-disconnected, using the same test as isNumberDisconnected() in
-- src/lib/whatsapp/numbers.ts: a row whose Meta registration failed keeps its
-- token and still holds the number. Reconnecting sets the token again, so the
-- row re-enters the index and is refused while another workspace holds it.
-- UNIQUE(account_id, phone_number_id) is unchanged: one row per number per
-- workspace.
--
-- Existing data satisfies the new index (it is weaker than the old one), so
-- nothing is rewritten or re-routed.

CREATE UNIQUE INDEX whatsapp_config_phone_number_id_connected_key ON whatsapp_config (phone_number_id)
  WHERE NOT (status = 'disconnected' AND access_token = '');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_phone_number_id_key'
             AND conrelid = 'whatsapp_config'::regclass) THEN
    ALTER TABLE whatsapp_config DROP CONSTRAINT whatsapp_config_phone_number_id_key;
  ELSE
    DROP INDEX whatsapp_config_phone_number_id_key;
  END IF;
END $$;

-- Inbound webhooks and the connect flows' "held elsewhere" check resolve a
-- phone_number_id to the one workspace that holds it connected; the index above
-- guarantees there is at most one. A number only disconnected everywhere
-- resolves to no workspace, as a deleted number used to. Signatures, owners and
-- grants are unchanged.
CREATE OR REPLACE FUNCTION crm_resolve_whatsapp_account(p_phone_number_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.account_id FROM whatsapp_config w
  WHERE w.phone_number_id = p_phone_number_id AND NOT (w.status = 'disconnected' AND w.access_token = '')
$$;

CREATE OR REPLACE FUNCTION resolve_whatsapp_routing(p_phone_number_id text)
RETURNS TABLE(account_id uuid,user_id uuid,verify_token text) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
  SELECT w.account_id,w.user_id,w.verify_token FROM whatsapp_config w
  WHERE w.phone_number_id = p_phone_number_id AND NOT (w.status = 'disconnected' AND w.access_token = '')
$$;
