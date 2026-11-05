-- Phase 14: SaaS billing reconciliation items.
--
-- A platform table (no tenant reads): the worker opens an item when a billing
-- webhook event fails, an intent stays 'unknown' after the sweep's reconcile
-- attempt for 24 h, an invoice could not be issued, the daily provider fetch
-- disagrees with the stored subscription, or a workspace's commerce Razorpay
-- key equals the platform key. Producers insert ON CONFLICT DO NOTHING (one
-- item per kind and source, never re-opened automatically). The console reads
-- and resolves them only through the definers below. Resolving never edits a
-- subscription or an intent. detail holds ids, statuses and amounts only.
-- Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE billing_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('event_error','intent_unknown','invoice_unissued','state_mismatch','shared_razorpay_key')),
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object' AND pg_column_size(detail) <= 8192),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_email text CHECK (char_length(resolved_by_email) <= 254),
  resolution_note text CHECK (char_length(resolution_note) <= 1000),
  UNIQUE (kind, source_ref),
  CHECK (status = 'open' OR (resolved_at IS NOT NULL AND resolved_by_email IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX billing_reconciliation_open_idx ON billing_reconciliation_items(opened_at DESC) WHERE status = 'open';
CREATE INDEX billing_reconciliation_account_idx ON billing_reconciliation_items(account_id, opened_at DESC) WHERE account_id IS NOT NULL;
ALTER TABLE billing_reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_reconciliation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_all ON billing_reconciliation_items FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON billing_reconciliation_items TO bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_owner ON billing_reconciliation_items FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;

-- Keyset paging on (opened_at, id): items opened in one transaction share
-- opened_at, so the id breaks the tie. cursor_at is opened_at at full
-- (microsecond) precision, for the next page's p_cursor_at.
CREATE FUNCTION crm_platform_reconciliation_list(p_status text, p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer)
RETURNS TABLE(id uuid, account_id uuid, account_name text, kind text, source_ref text, detail jsonb, status text,
  opened_at timestamptz, resolved_at timestamptz, resolved_by_email text, resolution_note text, cursor_at text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT i.id, i.account_id, a.name, i.kind, i.source_ref, i.detail, i.status, i.opened_at, i.resolved_at,
    i.resolved_by_email, i.resolution_note,
    to_char(i.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM billing_reconciliation_items i LEFT JOIN accounts a ON a.id = i.account_id
  WHERE (p_status IS NULL OR i.status = p_status)
    AND (p_cursor_at IS NULL OR (i.opened_at, i.id) < (p_cursor_at, COALESCE(p_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY i.opened_at DESC, i.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
$$;
REVOKE ALL ON FUNCTION crm_platform_reconciliation_list(text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_reconciliation_list(text, timestamptz, uuid, integer) TO bodhinox_platform;

-- Marks one open item resolved with a note; both audit trails. Returns false
-- when the item is unknown or already resolved.
CREATE FUNCTION crm_platform_reconciliation_resolve(p_id uuid, p_admin_email text, p_note text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item billing_reconciliation_items%ROWTYPE;
BEGIN
  IF p_note IS NULL OR char_length(trim(p_note)) < 3 THEN RAISE EXCEPTION 'note_required' USING ERRCODE = '22023'; END IF;
  UPDATE billing_reconciliation_items SET status = 'resolved', resolved_at = now(),
    resolved_by_email = lower(trim(p_admin_email)), resolution_note = left(trim(p_note), 1000)
    WHERE billing_reconciliation_items.id = p_id AND status = 'open'
    RETURNING * INTO item;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM crm_platform_audit(p_admin_email, 'billing.reconciliation_resolved', item.account_id, item.id::text, p_note,
    jsonb_build_object('kind', item.kind, 'source_ref', item.source_ref));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_platform_reconciliation_resolve(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_reconciliation_resolve(uuid, text, text) TO bodhinox_platform;

-- "Re-fetch from provider": queues the existing billing.lifecycle_sweep for
-- one workspace (fetch-then-apply, safe to repeat; deduplicated per minute).
CREATE FUNCTION crm_platform_billing_refetch(p_account uuid, p_admin_email text, p_reason text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE queued integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_subscriptions s WHERE s.account_id = p_account AND s.provider_subscription_id IS NOT NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO jobs(type, tenant_id, payload, dedupe_key, max_attempts)
    VALUES ('billing.lifecycle_sweep', p_account, '{}'::jsonb,
      'billing-refetch:' || p_account::text || ':' || to_char(now(), 'YYYYMMDDHH24MI'), 3)
    ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  PERFORM crm_platform_audit(p_admin_email, 'billing.refetch', p_account, p_account::text, p_reason,
    jsonb_build_object('queued', queued > 0));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_platform_billing_refetch(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_billing_refetch(uuid, text, text) TO bodhinox_platform;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_owner_enqueue ON jobs FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;

-- Workspaces the daily billing.reconcile job compares with the provider: every
-- live provider subscription. The owner SELECT policy billing_resolve_owner
-- (20261102130000_billing) already covers this definer.
CREATE FUNCTION crm_accounts_for_billing_reconcile() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM account_subscriptions s
  WHERE s.provider_subscription_id IS NOT NULL AND s.status <> 'cancelled'
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_billing_reconcile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_billing_reconcile() TO bodhinox_worker;
