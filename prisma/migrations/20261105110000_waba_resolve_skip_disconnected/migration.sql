-- WABA webhooks (template status, quality) resolve to the one workspace that
-- holds a number of that WABA connected. Migration 20261102102000 made
-- crm_resolve_whatsapp_account and resolve_whatsapp_routing skip admin-
-- disconnected rows (status 'disconnected', access_token ''), but this function
-- still counted them: after workspace X disconnected a number and workspace Y
-- connected it, the WABA mapped to two workspaces and resolved to none, so Y's
-- template updates were dropped. Use the same test here. A WABA whose numbers
-- are connected in more than one workspace still fails closed. Signature,
-- SECURITY DEFINER, search_path, owner and grants are unchanged.
CREATE OR REPLACE FUNCTION crm_resolve_waba_account(p_waba_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN count(DISTINCT w.account_id)=1 THEN min(w.account_id::text)::uuid ELSE NULL END
  FROM whatsapp_config w
  WHERE w.waba_id=p_waba_id AND NOT (w.status = 'disconnected' AND w.access_token = '')
$$;
