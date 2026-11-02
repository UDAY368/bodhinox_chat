-- Meta's webhook verification handshake accepts a verify token only from a
-- number that is connected somewhere.
--
-- Disconnecting a number keeps its row (status 'disconnected', access_token
-- cleared to ''), and with it the verify_token_hash, so the old function still
-- accepted a disconnected number's token. It now counts only rows that are not
-- admin-disconnected, the same test as the partial unique index
-- whatsapp_config_phone_number_id_connected_key (20261102102000) and
-- isNumberDisconnected() in src/lib/whatsapp/numbers.ts: a row whose Meta
-- registration failed keeps its token and still verifies.
--
-- CREATE OR REPLACE keeps the signature, owner, SECURITY DEFINER, search_path
-- and the EXECUTE grant to bodhinox_worker (PUBLIC stays revoked).
CREATE OR REPLACE FUNCTION crm_verify_webhook_token(p_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM whatsapp_config w
    WHERE w.verify_token_hash=p_hash AND NOT (w.status = 'disconnected' AND w.access_token = ''))
$$;
