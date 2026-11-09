-- Data retention (audit finding 39): the closed-workspace purge, complete
-- per-contact erasure, and bounded retention for finished jobs, processed
-- webhook receipts and realtime outbox events.
--
-- workspace_purges: one row per purged workspace, written in the purge
-- transaction (the audit record). No foreign key, so it outlives the workspace:
-- ids, dates and row counts only. The worker reads it (storage clean-up is
-- retried until storage_cleared_at is set) and may set storage_cleared_at.
--
-- purged_invoices: the Bodhinox tax invoices of a purged workspace, copied in
-- the purge transaction before the account row (and with it the invoices, by
-- ON DELETE CASCADE) is deleted. Invoices are statutory records and are kept.
-- No role reads it; an operator queries it as the migration owner.
--
-- crm_workspace_purge_check(account) locks the account and lifecycle rows and
-- returns NULL when the workspace may be purged now (closing, past purge_after,
-- no live provider subscription), else a reason code. crm_workspace_purge_finish
-- re-checks, writes the workspace_purges row and deletes the account row; every
-- tenant table cascades from it (audit_logs, billing_events and
-- billing_reconciliation_items are SET NULL and kept). Both refuse unless the
-- caller's tenant setting (withTenant) names the same workspace. The purge job
-- calls them only when WORKSPACE_PURGE_ENABLED=true.
--
-- Per-contact erasure (contact.erase job) runs on the worker role: it gains DELETE
-- on the contact-linked tables it did not have (unanswered AI questions, WhatsApp
-- form sessions and answers), each scoped to the tenant by RLS. Ad leads are
-- tombstoned with the existing worker UPDATE, as the lead delete does.
-- Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE workspace_purges (
  account_id uuid PRIMARY KEY,
  purge_after timestamptz,
  purged_at timestamptz NOT NULL DEFAULT now(),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object' AND pg_column_size(counts) <= 8192),
  invoices_retained integer NOT NULL DEFAULT 0 CHECK (invoices_retained >= 0),
  storage_cleared_at timestamptz
);
ALTER TABLE workspace_purges ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_purges FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_read ON workspace_purges FOR SELECT TO bodhinox_worker USING (true);
CREATE POLICY worker_storage ON workspace_purges FOR UPDATE TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT ON workspace_purges TO bodhinox_worker;
GRANT UPDATE (storage_cleared_at) ON workspace_purges TO bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY purge_owner ON workspace_purges FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

CREATE TABLE purged_invoices (
  invoice_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  number text NOT NULL,
  issued_at timestamptz NOT NULL,
  invoice jsonb NOT NULL CHECK (jsonb_typeof(invoice) = 'object'),
  archived_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purged_invoices_account_idx ON purged_invoices(account_id);
ALTER TABLE purged_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE purged_invoices FORCE ROW LEVEL SECURITY;
-- The purge job copies the workspace's own invoices inside its tenant transaction.
CREATE POLICY worker_archive ON purged_invoices FOR INSERT TO bodhinox_worker WITH CHECK (account_id = app_account_id());
GRANT INSERT ON purged_invoices TO bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY purge_owner ON purged_invoices FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Workspaces the purge job looks at: closing past purge_after (purged = false), and
-- purged ones whose stored files are not yet removed (purged = true, retried for 30 days).
CREATE FUNCTION crm_accounts_due_for_purge() RETURNS TABLE(account_id uuid, purged boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT l.account_id, false FROM account_lifecycle l WHERE l.status = 'closing' AND l.purge_after <= now()
  UNION ALL
  SELECT p.account_id, true FROM workspace_purges p WHERE p.storage_cleared_at IS NULL AND p.purged_at > now() - interval '30 days'
$$;
REVOKE ALL ON FUNCTION crm_accounts_due_for_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_due_for_purge() TO bodhinox_worker;

-- Every workspace id, for the hourly retention sweep's per-workspace outbox clean-up
-- (each delete then runs under that workspace's tenant scope and RLS).
CREATE FUNCTION crm_accounts_for_retention() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.id FROM accounts a
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_retention() TO bodhinox_worker;

CREATE FUNCTION crm_workspace_purge_check(p_account uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l record;
BEGIN
  IF p_account IS NULL OR NULLIF(current_setting('app.account_id', true), '') IS DISTINCT FROM p_account::text THEN
    RETURN 'scope_mismatch';
  END IF;
  -- Row locks: a concurrent cancel (or a new tenant row's key-share lock) waits, then is re-checked.
  PERFORM 1 FROM accounts a WHERE a.id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  SELECT status, purge_after INTO l FROM account_lifecycle WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND OR l.status <> 'closing' OR l.purge_after IS NULL OR l.purge_after > now() THEN RETURN 'not_due'; END IF;
  IF EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id = p_account
      AND s.provider_subscription_id IS NOT NULL AND s.status NOT IN ('cancelled','suspended','incomplete')) THEN
    RETURN 'live_subscription';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_workspace_purge_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_workspace_purge_check(uuid) TO bodhinox_worker;

CREATE FUNCTION crm_workspace_purge_finish(p_account uuid, p_counts jsonb, p_invoices integer) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reason text; due timestamptz;
BEGIN
  reason := crm_workspace_purge_check(p_account);
  IF reason IS NOT NULL THEN RETURN reason; END IF;
  SELECT purge_after INTO due FROM account_lifecycle WHERE account_id = p_account;
  INSERT INTO workspace_purges(account_id, purge_after, counts, invoices_retained)
    VALUES (p_account, due, COALESCE(p_counts, '{}'::jsonb), GREATEST(COALESCE(p_invoices, 0), 0));
  DELETE FROM accounts WHERE id = p_account;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_workspace_purge_finish(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_workspace_purge_finish(uuid, jsonb, integer) TO bodhinox_worker;

-- Per-contact erasure on the worker role (tenant-scoped policies already exist for these three).
GRANT DELETE ON ai_unanswered_questions TO bodhinox_worker;
CREATE POLICY worker_erase ON whatsapp_form_sessions FOR DELETE TO bodhinox_worker USING (account_id = app_account_id()); -- additive-exception: worker-only delete policy on a low-traffic table, for per-contact erasure
CREATE POLICY worker_erase ON whatsapp_form_responses FOR DELETE TO bodhinox_worker USING (account_id = app_account_id()); -- additive-exception: worker-only delete policy on a low-traffic table, for per-contact erasure
GRANT DELETE ON whatsapp_form_sessions, whatsapp_form_responses TO bodhinox_worker;
