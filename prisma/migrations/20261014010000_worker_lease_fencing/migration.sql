-- Fence every job lease so a stale worker cannot complete a successor's claim.
ALTER TABLE jobs ADD COLUMN lease_token uuid;
-- Accepted outbound results can be replayed without dispatching the provider again.
ALTER TABLE outbound_intents ADD COLUMN result jsonb;

-- WABA event routing must not pick an arbitrary account when several numbers share it.
CREATE FUNCTION crm_resolve_waba_account(p_waba_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN count(DISTINCT w.account_id)=1 THEN min(w.account_id::text)::uuid ELSE NULL END
  FROM whatsapp_config w WHERE w.waba_id=p_waba_id
$$;
REVOKE ALL ON FUNCTION crm_resolve_waba_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_waba_account(text) TO bodhinox_worker;
