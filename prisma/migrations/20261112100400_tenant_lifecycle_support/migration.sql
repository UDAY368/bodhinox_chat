-- Phase 14: tenant lifecycle, consented support access and the console reads.
--
-- account_lifecycle: one optional row per workspace; no row = 'active', so
-- nothing is backfilled and no workspace changes at deploy. 'admin_suspended'
-- (platform admin, reason required) and 'closing' (owner deletion request)
-- stop sends like billing suspension does; inbound, opt-outs, payment webhooks
-- and reconciliation are unaffected. block_manual (abuse) also refuses manual
-- agent replies. Owners may only request or cancel their own deletion
-- (column grants + policy); they can never clear an admin suspension or
-- block_manual. There is no purge job: rows past purge_after are listed in the
-- console as "purge due".
--
-- support_grants: a platform admin asks, a workspace owner/admin approves,
-- denies or revokes (or grants proactively to a named allowlisted email), for
-- at most 24 hours, diagnostics scope only. While approved and unexpired,
-- crm_platform_support_diagnostics returns a fixed diagnostic DTO for that one
-- workspace (statuses, counts, error codes; never message bodies, contact
-- fields, secrets or tokens) and logs support.viewed to both trails.
--
-- crm_platform_* read functions for the console return fixed columns only.
-- Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE account_lifecycle (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','admin_suspended','closing')),
  block_manual boolean NOT NULL DEFAULT false,
  suspended_at timestamptz,
  suspend_reason text CHECK (char_length(suspend_reason) <= 1000),
  suspended_by_email text CHECK (char_length(suspended_by_email) <= 254),
  deletion_requested_at timestamptz,
  deletion_requested_by uuid,
  purge_after timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'admin_suspended' OR (suspended_at IS NOT NULL AND suspend_reason IS NOT NULL)),
  CHECK (status <> 'closing' OR (deletion_requested_at IS NOT NULL AND purge_after IS NOT NULL))
);
ALTER TABLE account_lifecycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_lifecycle FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON account_lifecycle FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Owners request or cancel deletion of their own workspace; an admin-suspended row is out of reach.
CREATE POLICY owner_insert ON account_lifecycle FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('owner') AND status IN ('active','closing') AND NOT block_manual);
CREATE POLICY owner_update ON account_lifecycle FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('owner') AND status IN ('active','closing'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('owner') AND status IN ('active','closing'));
GRANT SELECT ON account_lifecycle TO bodhinox_app, bodhinox_worker;
GRANT INSERT (account_id, status, deletion_requested_at, deletion_requested_by, purge_after, updated_at),
  UPDATE (status, deletion_requested_at, deletion_requested_by, purge_after, updated_at) ON account_lifecycle TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_lifecycle
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE support_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by_email text NOT NULL CHECK (char_length(requested_by_email) BETWEEN 3 AND 254 AND requested_by_email LIKE '%@%'),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
  scope text NOT NULL DEFAULT 'diagnostics' CHECK (scope IN ('diagnostics')),
  -- The access window asked for (or granted proactively); the approver may grant it as asked.
  requested_minutes integer NOT NULL DEFAULT 60 CHECK (requested_minutes BETWEEN 15 AND 1440),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','denied','revoked','expired')),
  decided_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (account_id, id),
  CHECK (expires_at IS NULL OR (decided_at IS NOT NULL AND expires_at <= decided_at + interval '24 hours')),
  CHECK (status <> 'approved' OR (decided_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);
CREATE UNIQUE INDEX support_grants_one_open ON support_grants(account_id, requested_by_email)
  WHERE status IN ('requested','approved');
CREATE INDEX support_grants_account_idx ON support_grants(account_id, requested_at DESC);
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON support_grants FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY admin_insert ON support_grants FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin') AND status = 'approved' AND decided_by = app_user_id());
CREATE POLICY admin_update ON support_grants FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT ON support_grants TO bodhinox_app;
GRANT INSERT (account_id, requested_by_email, reason, scope, requested_minutes, status, decided_by, decided_at, expires_at),
  UPDATE (status, decided_by, decided_at, expires_at, revoked_at) ON support_grants TO bodhinox_app;

-- Allowed transitions only, for every role: requested -> approved|denied|expired,
-- approved -> revoked|expired. The request itself never changes.
CREATE FUNCTION support_grants_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.requested_by_email <> OLD.requested_by_email OR NEW.reason <> OLD.reason
     OR NEW.scope <> OLD.scope OR NEW.requested_at <> OLD.requested_at OR NEW.requested_minutes <> OLD.requested_minutes THEN
    RAISE EXCEPTION 'support grant request is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved','denied','expired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('revoked','expired'))) THEN
    RAISE EXCEPTION 'invalid support grant transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION support_grants_transition() FROM PUBLIC;
CREATE TRIGGER support_grants_transition BEFORE UPDATE ON support_grants
  FOR EACH ROW EXECUTE FUNCTION support_grants_transition();

DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_owner ON account_lifecycle FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY platform_owner ON support_grants FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY platform_owner_notify ON notifications FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;
-- Owner SELECT policies for the console reads, created only where missing:
-- jobs, outbound_intents, billing_intents, payment_exceptions,
-- ai_workspace_settings, whatsapp_config, instagram_accounts,
-- meta_ad_connections, meeting_connections, courier_connections,
-- shopify_stores, woocommerce_stores, payment_providers, account_memberships,
-- usage_counters, account_subscriptions.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','outbound_intents','billing_intents','payment_exceptions','ai_workspace_settings',
    'whatsapp_config','instagram_accounts','meta_ad_connections','meeting_connections','courier_connections',
    'shopify_stores','woocommerce_stores','payment_providers','account_memberships','usage_counters','account_subscriptions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t
        AND current_user::name = ANY(p.roles) AND p.cmd IN ('SELECT','ALL')) THEN
      EXECUTE format('CREATE POLICY platform_owner_read ON %I FOR SELECT TO %I USING (true)', t, current_user);
    END IF;
  END LOOP;
END $$;

-- A 'billing'-type notification to every owner and admin of a workspace.
CREATE FUNCTION crm_platform_notify_admins(p_account uuid, p_title text, p_body text, p_link text, p_dedupe text)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  INSERT INTO notifications(account_id, user_id, type, title, body, link, dedupe_key)
  SELECT m.account_id, m.user_id, 'billing', left(p_title, 200), left(p_body, 1000), p_link, left(p_dedupe, 200)
  FROM account_memberships m WHERE m.account_id = p_account AND m.role IN ('owner','admin')
  ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION crm_platform_notify_admins(uuid, text, text, text, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Tenants list: stored usage only (usage_counters for the current IST month), no live counts.
CREATE FUNCTION crm_platform_tenants(p_search text, p_cursor timestamptz, p_limit integer)
RETURNS TABLE(account_id uuid, name text, created_at timestamptz, owner_email text, plan_id text, plan_version integer,
  subscription_status text, lifecycle_status text, block_manual boolean, purge_after timestamptz,
  member_count bigint, usage jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.id, a.name, a.created_at, u.email,
    CASE WHEN s.account_id IS NULL THEN 'enterprise' WHEN s.status IN ('suspended','cancelled','incomplete') THEN 'free' ELSE s.plan_id END,
    v.version, s.status, COALESCE(l.status, 'active'), COALESCE(l.block_manual, false), l.purge_after,
    (SELECT count(*) FROM account_memberships m WHERE m.account_id = a.id),
    (SELECT COALESCE(jsonb_object_agg(c.metric, c.value), '{}'::jsonb) FROM usage_counters c
      WHERE c.account_id = a.id AND c.period = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'))
  FROM accounts a
  LEFT JOIN auth_users u ON u.id = a.owner_user_id
  LEFT JOIN account_subscriptions s ON s.account_id = a.id
  LEFT JOIN plan_versions v ON v.id = s.plan_version_id
  LEFT JOIN account_lifecycle l ON l.account_id = a.id
  WHERE (p_cursor IS NULL OR a.created_at < p_cursor)
    AND (p_search IS NULL OR p_search = '' OR a.id::text = p_search
      OR a.name ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      OR u.email ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ORDER BY a.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
$$;
REVOKE ALL ON FUNCTION crm_platform_tenants(text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_tenants(text, timestamptz, integer) TO bodhinox_platform;

-- One workspace: the list row plus subscription, lifecycle, members by role and
-- open items. NULL when the workspace does not exist.
CREATE FUNCTION crm_platform_tenant(p_account uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'account_id', a.id, 'name', a.name, 'created_at', a.created_at, 'owner_email', u.email,
    'plan_id', CASE WHEN s.account_id IS NULL THEN 'enterprise' WHEN s.status IN ('suspended','cancelled','incomplete') THEN 'free' ELSE s.plan_id END,
    'plan_version', v.version,
    'subscription', CASE WHEN s.account_id IS NULL THEN NULL ELSE jsonb_build_object(
      'plan_id', s.plan_id, 'status', s.status, 'interval', s."interval", 'provider', s.provider,
      'has_provider_subscription', s.provider_subscription_id IS NOT NULL,
      'current_period_end', s.current_period_end, 'cancel_at_period_end', s.cancel_at_period_end,
      'scheduled_plan', s.scheduled_plan, 'grace_ends_at', s.grace_ends_at, 'suspended_at', s.suspended_at) END,
    'lifecycle', jsonb_build_object('status', COALESCE(l.status, 'active'), 'block_manual', COALESCE(l.block_manual, false),
      'suspended_at', l.suspended_at, 'suspend_reason', l.suspend_reason, 'suspended_by_email', l.suspended_by_email,
      'deletion_requested_at', l.deletion_requested_at, 'purge_after', l.purge_after),
    'members', (SELECT COALESCE(jsonb_object_agg(r.role, r.n), '{}'::jsonb)
      FROM (SELECT m.role, count(*) AS n FROM account_memberships m WHERE m.account_id = a.id GROUP BY m.role) r),
    'usage', (SELECT COALESCE(jsonb_object_agg(c.metric, c.value), '{}'::jsonb) FROM usage_counters c
      WHERE c.account_id = a.id AND c.period = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')),
    'open_reconciliation_items', (SELECT count(*) FROM billing_reconciliation_items i WHERE i.account_id = a.id AND i.status = 'open'),
    'support_grants', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', g.id, 'requested_by_email', g.requested_by_email,
        'status', CASE WHEN g.status = 'approved' AND g.expires_at <= now() THEN 'expired' ELSE g.status END,
        'requested_at', g.requested_at, 'expires_at', g.expires_at) ORDER BY g.requested_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM support_grants g0 WHERE g0.account_id = a.id ORDER BY g0.requested_at DESC LIMIT 20) g))
  FROM accounts a
  LEFT JOIN auth_users u ON u.id = a.owner_user_id
  LEFT JOIN account_subscriptions s ON s.account_id = a.id
  LEFT JOIN plan_versions v ON v.id = s.plan_version_id
  LEFT JOIN account_lifecycle l ON l.account_id = a.id
  WHERE a.id = p_account
$$;
REVOKE ALL ON FUNCTION crm_platform_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_tenant(uuid) TO bodhinox_platform;

-- Integration health per workspace from stored status columns (no provider
-- calls). Only workspaces with something to look at are returned. A workspace
-- whose commerce Razorpay key id equals the platform key id is flagged and a
-- shared_razorpay_key reconciliation item is opened (nothing else changes).
CREATE FUNCTION crm_platform_integration_health(p_platform_key_id text)
RETURNS TABLE(account_id uuid, account_name text, disconnected_numbers bigint, number_health_errors bigint,
  instagram_attention bigint, meta_ads_attention bigint, meetings_attention bigint, courier_attention bigint,
  tokens_expiring bigint, shared_razorpay_key boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_platform_key_id IS NOT NULL AND p_platform_key_id <> '' THEN
    INSERT INTO billing_reconciliation_items(account_id, kind, source_ref, detail)
      SELECT pp.account_id, 'shared_razorpay_key', 'payment_provider:' || pp.id::text, jsonb_build_object('payment_provider_id', pp.id)
      FROM payment_providers pp WHERE pp.key_id = p_platform_key_id
      ON CONFLICT (kind, source_ref) DO NOTHING;
  END IF;
  RETURN QUERY
  SELECT * FROM (
    SELECT a.id, a.name,
      (SELECT count(*) FROM whatsapp_config w WHERE w.account_id = a.id AND w.status = 'disconnected' AND w.access_token <> ''),
      (SELECT count(*) FROM whatsapp_config w WHERE w.account_id = a.id AND w.health_error_at IS NOT NULL
        AND (w.health_checked_at IS NULL OR w.health_error_at >= w.health_checked_at)),
      (SELECT count(*) FROM instagram_accounts x WHERE x.account_id = a.id AND x.status IN ('token_invalid','permission_missing')),
      (SELECT count(*) FROM meta_ad_connections x WHERE x.account_id = a.id AND x.status = 'token_invalid'),
      (SELECT count(*) FROM meeting_connections x WHERE x.account_id = a.id AND x.status <> 'disconnected' AND (x.status <> 'active' OR x.last_error_code IS NOT NULL)),
      (SELECT count(*) FROM courier_connections x WHERE x.account_id = a.id AND x.status <> 'disconnected' AND (x.status <> 'active' OR x.last_error_code IS NOT NULL)),
      (SELECT count(*) FROM instagram_accounts x WHERE x.account_id = a.id AND x.status = 'active' AND x.token_expires_at < now() + interval '7 days')
        + (SELECT count(*) FROM meta_ad_connections x WHERE x.account_id = a.id AND x.status = 'active' AND x.token_expires_at < now() + interval '7 days'),
      (p_platform_key_id IS NOT NULL AND p_platform_key_id <> ''
        AND EXISTS (SELECT 1 FROM payment_providers pp WHERE pp.account_id = a.id AND pp.key_id = p_platform_key_id))
    FROM accounts a
  ) h(account_id, account_name, disconnected_numbers, number_health_errors, instagram_attention, meta_ads_attention,
      meetings_attention, courier_attention, tokens_expiring, shared_razorpay_key)
  WHERE h.disconnected_numbers + h.number_health_errors + h.instagram_attention + h.meta_ads_attention
      + h.meetings_attention + h.courier_attention + h.tokens_expiring > 0 OR h.shared_razorpay_key
  ORDER BY h.shared_razorpay_key DESC, h.account_name
  LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION crm_platform_integration_health(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_integration_health(text) TO bodhinox_platform;

-- Background work that needs a look: failed jobs (7 days) and overdue pending
-- jobs by type, and unprocessed webhook receipts (24 h) by provider. Counts only.
CREATE FUNCTION crm_platform_job_backlog()
RETURNS TABLE(source text, type text, status text, workspaces bigint, items bigint, oldest timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT 'jobs', j.type, CASE WHEN j.status = 'failed' THEN 'failed' ELSE 'overdue' END,
    count(DISTINCT j.tenant_id), count(*), min(j.run_at)
  FROM jobs j
  WHERE (j.status = 'failed' AND j.updated_at > now() - interval '7 days')
     OR (j.status = 'pending' AND j.run_at < now() - interval '15 minutes')
  GROUP BY j.type, CASE WHEN j.status = 'failed' THEN 'failed' ELSE 'overdue' END
  UNION ALL
  SELECT 'webhook_receipts', r.provider, r.status, NULL::bigint, count(*), min(r.created_at)
  FROM webhook_receipts r
  WHERE r.status <> 'processed' AND r.created_at > now() - interval '24 hours' AND r.created_at < now() - interval '5 minutes'
  GROUP BY r.provider, r.status
  ORDER BY 5 DESC
  LIMIT 200
$$;
REVOKE ALL ON FUNCTION crm_platform_job_backlog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_job_backlog() TO bodhinox_platform;

-- Admin suspend / reactivate / block manual replies. Reason required; both
-- audit trails; owners and admins notified of what actually changed.
-- p_block_manual NULL keeps the current value. 'closing' belongs to the
-- owner's deletion request and is never set or cleared here: on a closing
-- workspace a suspension is recorded as a hold (the suspend fields set, status
-- stays 'closing', so the purge countdown is kept and the owner cannot cancel
-- the deletion while it is held), and block_manual still applies.
-- Action: a hold change -> lifecycle.admin_suspended / lifecycle.reactivated
-- (the suspension metadata is written only then); otherwise a block_manual
-- change -> lifecycle.manual_blocked / lifecycle.manual_unblocked; no change
-- -> nothing is written or sent.
CREATE FUNCTION crm_platform_set_lifecycle(p_account uuid, p_status text, p_block_manual boolean, p_reason text, p_admin_email text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cur account_lifecycle%ROWTYPE; was_held boolean; now_held boolean := p_status = 'admin_suspended';
  was_block boolean; new_block boolean; act text; title text; body text;
BEGIN
  IF p_status NOT IN ('active','admin_suspended') THEN RAISE EXCEPTION 'invalid_lifecycle_status' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p_account) THEN RAISE EXCEPTION 'unknown_account' USING ERRCODE = '22023'; END IF;
  SELECT * INTO cur FROM account_lifecycle WHERE account_id = p_account FOR UPDATE;
  was_held := FOUND AND (cur.status = 'admin_suspended' OR (cur.status = 'closing' AND cur.suspend_reason IS NOT NULL));
  was_block := FOUND AND cur.block_manual;
  new_block := COALESCE(p_block_manual, was_block);
  IF was_held = now_held AND was_block = new_block THEN RETURN; END IF;
  IF was_held <> now_held THEN
    INSERT INTO account_lifecycle(account_id, status, block_manual, suspended_at, suspend_reason, suspended_by_email)
      VALUES (p_account, p_status, new_block,
        CASE WHEN now_held THEN now() END,
        CASE WHEN now_held THEN left(trim(p_reason), 1000) END,
        CASE WHEN now_held THEN left(lower(trim(p_admin_email)), 254) END)
      ON CONFLICT (account_id) DO UPDATE SET
        status = CASE WHEN account_lifecycle.status = 'closing' THEN 'closing' ELSE EXCLUDED.status END,
        block_manual = EXCLUDED.block_manual, suspended_at = EXCLUDED.suspended_at,
        suspend_reason = EXCLUDED.suspend_reason, suspended_by_email = EXCLUDED.suspended_by_email;
    act := CASE WHEN now_held THEN 'lifecycle.admin_suspended' ELSE 'lifecycle.reactivated' END;
    title := CASE WHEN now_held THEN 'Workspace suspended by Bodhinox support' ELSE 'Workspace reactivated' END;
    body := CASE WHEN now_held THEN 'Sending is paused for this workspace. Contact Bodhinox support for details. Incoming messages are still received.'
      WHEN new_block THEN 'Automatic sending is available again. Manual replies stay blocked by Bodhinox support.'
      ELSE 'Sending is available again for this workspace.' END;
  ELSE
    -- Only block_manual changes: the suspension metadata (if any) is kept as it was.
    INSERT INTO account_lifecycle(account_id, status, block_manual) VALUES (p_account, 'active', new_block)
      ON CONFLICT (account_id) DO UPDATE SET block_manual = EXCLUDED.block_manual;
    act := CASE WHEN new_block THEN 'lifecycle.manual_blocked' ELSE 'lifecycle.manual_unblocked' END;
    title := CASE WHEN new_block THEN 'Manual replies blocked by Bodhinox support' ELSE 'Manual replies available again' END;
    body := CASE WHEN new_block THEN 'Members cannot send replies from this workspace. Contact Bodhinox support for details. Incoming messages are still received.'
      ELSE 'Members can send replies from this workspace again.' END;
  END IF;
  PERFORM crm_platform_audit(p_admin_email, act, p_account, p_account::text, p_reason,
    jsonb_build_object('status', COALESCE((SELECT l.status FROM account_lifecycle l WHERE l.account_id = p_account), 'active'),
      'held', now_held, 'block_manual', new_block,
      'previous_status', COALESCE(cur.status, 'active'), 'previous_block_manual', was_block));
  PERFORM crm_platform_notify_admins(p_account, title, body, '/settings?tab=billing', NULL);
END $$;
REVOKE ALL ON FUNCTION crm_platform_set_lifecycle(uuid, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_set_lifecycle(uuid, text, boolean, text, text) TO bodhinox_platform;

-- A platform admin asks a workspace for diagnostics access. One open request
-- per workspace and admin; grants whose window passed are marked expired first.
CREATE FUNCTION crm_platform_support_request(p_account uuid, p_admin_email text, p_reason text, p_minutes integer)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result uuid; email text := lower(trim(p_admin_email));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p_account) THEN RAISE EXCEPTION 'unknown_account' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  IF p_minutes IS NULL OR p_minutes < 15 OR p_minutes > 1440 THEN RAISE EXCEPTION 'invalid_duration' USING ERRCODE = '22023'; END IF;
  UPDATE support_grants SET status = 'expired'
    WHERE account_id = p_account AND requested_by_email = email AND status = 'approved' AND expires_at <= now();
  UPDATE support_grants SET status = 'expired'
    WHERE account_id = p_account AND requested_by_email = email AND status = 'requested' AND requested_at < now() - interval '7 days';
  INSERT INTO support_grants(account_id, requested_by_email, reason, requested_minutes)
    VALUES (p_account, email, left(trim(p_reason), 1000), p_minutes)
    ON CONFLICT DO NOTHING
    RETURNING id INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'support_request_open' USING ERRCODE = '23505'; END IF;
  PERFORM crm_platform_audit(email, 'support.requested', p_account, result::text, p_reason,
    jsonb_build_object('minutes', p_minutes, 'scope', 'diagnostics'));
  PERFORM crm_platform_notify_admins(p_account, 'Bodhinox support asked for diagnostics access',
    'Review the request in Settings, Privacy and access. Support sees statuses and error codes only, never messages or contacts.',
    '/settings?tab=privacy', 'support-request:' || result::text);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION crm_platform_support_request(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_support_request(uuid, text, text, integer) TO bodhinox_platform;

-- The grants a platform admin can see: their own across workspaces, newest first.
CREATE FUNCTION crm_platform_support_grants(p_admin_email text, p_account uuid)
RETURNS TABLE(id uuid, account_id uuid, account_name text, reason text, requested_minutes integer, status text,
  requested_at timestamptz, decided_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT g.id, g.account_id, a.name, g.reason, g.requested_minutes,
    CASE WHEN g.status = 'approved' AND g.expires_at <= now() THEN 'expired' ELSE g.status END,
    g.requested_at, g.decided_at, g.expires_at
  FROM support_grants g JOIN accounts a ON a.id = g.account_id
  WHERE g.requested_by_email = lower(trim(p_admin_email)) AND (p_account IS NULL OR g.account_id = p_account)
  ORDER BY g.requested_at DESC LIMIT 100
$$;
REVOKE ALL ON FUNCTION crm_platform_support_grants(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_support_grants(text, uuid) TO bodhinox_platform;

-- The extended diagnostic DTO for one workspace, only while the caller's grant
-- is approved and unexpired. Statuses, counts and error codes only.
CREATE FUNCTION crm_platform_support_diagnostics(p_grant uuid, p_admin_email text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g support_grants%ROWTYPE; email text := lower(trim(p_admin_email)); acct uuid; result jsonb;
BEGIN
  SELECT * INTO g FROM support_grants WHERE id = p_grant;
  IF NOT FOUND OR g.requested_by_email <> email OR g.status <> 'approved' OR g.expires_at IS NULL OR g.expires_at <= now() THEN
    RAISE EXCEPTION 'grant_not_active' USING ERRCODE = '42501';
  END IF;
  acct := g.account_id;
  SELECT jsonb_build_object(
    'account_id', acct, 'grant_id', g.id, 'expires_at', g.expires_at,
    'subscription', (SELECT jsonb_build_object('plan_id', s.plan_id, 'status', s.status, 'current_period_end', s.current_period_end,
        'cancel_at_period_end', s.cancel_at_period_end, 'has_provider_subscription', s.provider_subscription_id IS NOT NULL)
      FROM account_subscriptions s WHERE s.account_id = acct),
    'lifecycle', (SELECT jsonb_build_object('status', l.status, 'block_manual', l.block_manual) FROM account_lifecycle l WHERE l.account_id = acct),
    'usage', (SELECT COALESCE(jsonb_object_agg(c.metric, c.value), '{}'::jsonb) FROM usage_counters c
      WHERE c.account_id = acct AND c.period = to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')),
    'whatsapp_numbers', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', w.id, 'status', w.status, 'quality_rating', w.quality_rating,
        'messaging_limit_tier', w.messaging_limit_tier, 'has_token', w.access_token <> '', 'health_checked_at', w.health_checked_at,
        'health_error_at', w.health_error_at, 'registered', w.registered_at IS NOT NULL)), '[]'::jsonb)
      FROM whatsapp_config w WHERE w.account_id = acct),
    'integrations', jsonb_build_object(
      'instagram', (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', x.status, 'last_error_code', x.last_error_code,
          'token_expires_at', x.token_expires_at, 'last_webhook_at', x.last_webhook_at)), '[]'::jsonb) FROM instagram_accounts x WHERE x.account_id = acct),
      'meta_ads', (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', x.status, 'last_error_code', x.last_error_code,
          'token_expires_at', x.token_expires_at)), '[]'::jsonb) FROM meta_ad_connections x WHERE x.account_id = acct),
      'meetings', (SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', x.provider, 'status', x.status, 'last_error_code', x.last_error_code,
          'token_expires_at', x.token_expires_at)), '[]'::jsonb) FROM meeting_connections x WHERE x.account_id = acct),
      'courier', (SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', x.provider, 'status', x.status, 'last_error_code', x.last_error_code)), '[]'::jsonb)
        FROM courier_connections x WHERE x.account_id = acct),
      'shopify', (SELECT count(*) FROM shopify_stores x WHERE x.account_id = acct AND x.uninstalled_at IS NULL),
      'woocommerce', (SELECT count(*) FROM woocommerce_stores x WHERE x.account_id = acct),
      'razorpay_commerce', (SELECT COALESCE(jsonb_agg(jsonb_build_object('mode', x.mode, 'connected_at', x.connected_at)), '[]'::jsonb)
        FROM payment_providers x WHERE x.account_id = acct)),
    'failed_jobs', (SELECT COALESCE(jsonb_agg(jsonb_build_object('type', j.type, 'count', j.n, 'last_at', j.last_at)), '[]'::jsonb)
      FROM (SELECT type, count(*) AS n, max(updated_at) AS last_at FROM jobs
            WHERE tenant_id = acct AND status = 'failed' AND updated_at > now() - interval '7 days' GROUP BY type) j),
    'outbound_intents', (SELECT COALESCE(jsonb_object_agg(o.status, o.n), '{}'::jsonb)
      FROM (SELECT status, count(*) AS n FROM outbound_intents WHERE account_id = acct AND created_at > now() - interval '7 days' GROUP BY status) o),
    'billing_intents', (SELECT COALESCE(jsonb_object_agg(b.status, b.n), '{}'::jsonb)
      FROM (SELECT status, count(*) AS n FROM billing_intents WHERE account_id = acct GROUP BY status) b),
    'open_payment_exceptions', (SELECT count(*) FROM payment_exceptions p WHERE p.account_id = acct AND p.status = 'open'),
    'open_reconciliation_items', (SELECT count(*) FROM billing_reconciliation_items i WHERE i.account_id = acct AND i.status = 'open'),
    'settings', (SELECT jsonb_build_object('ai_summaries', s.summaries_enabled, 'ai_suggestions', s.suggestions_enabled,
        'ai_assessment', s.assessment_enabled, 'ai_insights', s.insights_enabled, 'ai_monthly_token_cap', s.monthly_token_cap)
      FROM ai_workspace_settings s WHERE s.account_id = acct)
  ) INTO result;
  -- One support.viewed row per grant per 5 minutes, in both trails.
  IF NOT EXISTS (SELECT 1 FROM platform_audit_log p WHERE p.action = 'support.viewed' AND p.target_ref = g.id::text
      AND p.created_at > now() - interval '5 minutes') THEN
    PERFORM crm_platform_audit(email, 'support.viewed', acct, g.id::text, NULL, jsonb_build_object('scope', g.scope));
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION crm_platform_support_diagnostics(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_support_diagnostics(uuid, text) TO bodhinox_platform;

CREATE FUNCTION crm_platform_audit_list(p_account uuid, p_cursor timestamptz, p_limit integer)
RETURNS TABLE(id uuid, admin_email text, action text, target_account_id uuid, target_ref text, reason text, detail jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.id, p.admin_email, p.action, p.target_account_id, p.target_ref, p.reason, p.detail, p.created_at
  FROM platform_audit_log p
  WHERE (p_account IS NULL OR p.target_account_id = p_account) AND (p_cursor IS NULL OR p.created_at < p_cursor)
  ORDER BY p.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
$$;
REVOKE ALL ON FUNCTION crm_platform_audit_list(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_audit_list(uuid, timestamptz, integer) TO bodhinox_platform;
