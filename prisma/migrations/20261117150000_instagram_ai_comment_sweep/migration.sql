-- Instagram Phase 2 (Stage 3, 3C): the worker's schedule for AI comment replies.
--
-- crm_instagram_ai_comment_accounts() lists the workspaces whose worker should
-- look at AI comment work: those that switched AI comment replies on with an
-- active AI config and a live Instagram account, plus any with an approved
-- reply still waiting to be posted (so turning the switch off never strands a
-- reply an admin already approved). Like crm_instagram_accounts_for_sweep()
-- it is SECURITY DEFINER and executable by the worker only, because the
-- scheduler runs before any workspace is chosen. It returns ids, nothing else.
-- Additive: a new function.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION crm_instagram_ai_comment_accounts()
RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT w.account_id FROM (
    SELECT c.account_id FROM ai_configs c
    WHERE c.instagram_ai_comments_enabled AND c.is_active
      AND EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.account_id = c.account_id AND a.status = 'active')
    UNION ALL
    SELECT q.account_id FROM instagram_ai_comment_queue q WHERE q.status = 'approved'
  ) w
  ORDER BY w.account_id
  LIMIT 5000
$$;
REVOKE ALL ON FUNCTION crm_instagram_ai_comment_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_instagram_ai_comment_accounts() TO bodhinox_worker;
