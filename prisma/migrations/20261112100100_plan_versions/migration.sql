-- Phase 14: versioned plan configuration.
--
-- plan_versions is a platform catalogue (no tenant data): each published edit
-- of a plan's features/limits is a new immutable version. Version 1 of every
-- plan is backfilled from the plans row as it is today, and every subscription
-- whose status grants its plan is pinned to that version 1, so every workspace
-- resolves to exactly the terms it has now. A workspace with no subscription
-- row stays on the live 'enterprise' row (unrestricted); a non-granting status
-- stays on the live 'free' row.
--
-- Writes go only through crm_platform_publish_plan_version (platform role),
-- which repeats the key/type validation in SQL, refuses tightening the legacy
-- 'enterprise' fallback, and requires the hash of a preview taken against the
-- same current version. Existing plans rows keep their values.
--
-- account_subscriptions.plan_version_id is added with a NOT VALID foreign key
-- (validated in 20261112100600_platform_validate). Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id text NOT NULL REFERENCES plans(id),
  version integer NOT NULL CHECK (version > 0),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  note text CHECK (char_length(note) <= 500),
  created_by_email text CHECK (char_length(created_by_email) <= 254),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);
GRANT SELECT ON plan_versions TO bodhinox_app, bodhinox_worker;
INSERT INTO plan_versions(plan_id, version, features, limits, note)
  SELECT p.id, 1, p.features, p.limits, 'Initial version (plan as of Phase 14 deploy)' FROM plans p;

-- Constant default: a metadata-only column add.
ALTER TABLE plans ADD COLUMN current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0);

ALTER TABLE account_subscriptions ADD COLUMN plan_version_id uuid;
ALTER TABLE account_subscriptions ADD CONSTRAINT account_subscriptions_plan_version_fkey
  FOREIGN KEY (plan_version_id) REFERENCES plan_versions(id) NOT VALID;
-- FORCE RLS would hide the rows from the migration owner: lifted only for this
-- statement and restored before commit (same bracket as 20261102130000_billing).
ALTER TABLE account_subscriptions NO FORCE ROW LEVEL SECURITY;
UPDATE account_subscriptions s SET plan_version_id = v.id
  FROM plan_versions v
  WHERE v.plan_id = s.plan_id AND v.version = 1 AND s.plan_version_id IS NULL
    AND s.status NOT IN ('suspended','cancelled','incomplete');
ALTER TABLE account_subscriptions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Keys a plan may carry. Must equal FEATURES / LIMITS in
-- src/lib/billing/entitlements-catalogue.ts (a unit test compares them).
CREATE FUNCTION crm_plan_feature_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT ARRAY['campaign_scheduling','contact_export','api_campaigns','click_tracking','retargeting',
    'workspace_attributes','appointments','storefront','online_meetings','courier_shipping','instagram']::text[]
$$;
CREATE FUNCTION crm_plan_limit_keys() RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT ARRAY['seats','segments','lists','campaign_recipients','active_flows','active_automations',
    'ai_messages','monthly_active_contacts','storage_bytes','whatsapp_numbers','appointment_staff',
    'instagram_accounts','ai_tokens_monthly','contacts','integrations','messages_monthly']::text[]
$$;
REVOKE ALL ON FUNCTION crm_plan_feature_keys() FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_plan_limit_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_plan_feature_keys(), crm_plan_limit_keys() TO bodhinox_app, bodhinox_worker, bodhinox_platform;

-- Raises 'invalid_plan_terms' unless every feature is a known key with a
-- boolean value and every limit a known key with JSON null or a non-negative
-- safe integer.
CREATE FUNCTION crm_platform_validate_plan_terms(p_features jsonb, p_limits jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
  IF p_features IS NULL OR jsonb_typeof(p_features) <> 'object' OR p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' THEN
    RAISE EXCEPTION 'invalid_plan_terms' USING ERRCODE = '22023';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(p_features) LOOP
    IF NOT (k = ANY (crm_plan_feature_keys())) OR jsonb_typeof(v) <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_plan_terms' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR k, v IN SELECT * FROM jsonb_each(p_limits) LOOP
    IF NOT (k = ANY (crm_plan_limit_keys())) THEN RAISE EXCEPTION 'invalid_plan_terms' USING ERRCODE = '22023'; END IF;
    IF jsonb_typeof(v) = 'null' THEN CONTINUE; END IF;
    IF jsonb_typeof(v) <> 'number' OR (v::text)::numeric < 0 OR (v::text)::numeric <> trunc((v::text)::numeric)
       OR (v::text)::numeric > 9007199254740991 THEN
      RAISE EXCEPTION 'invalid_plan_terms' USING ERRCODE = '22023';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION crm_platform_validate_plan_terms(jsonb, jsonb) FROM PUBLIC;

-- The preview hash binds a publish to the preview of the same draft against
-- the same current version. jsonb::text is canonical, so key order in the
-- request does not matter.
CREATE FUNCTION crm_platform_plan_hash(p_plan text, p_version integer, p_features jsonb, p_limits jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT encode(sha256(convert_to(p_plan || ':' || p_version::text || ':' || p_features::text || ':' || p_limits::text, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION crm_platform_plan_hash(text, integer, jsonb, jsonb) FROM PUBLIC;

-- Current usage of one limit for one workspace, counted the way the gates
-- count (src/lib/billing/usage.ts currentUsage, integration-count.ts).
-- NULL for soft limits (never enforced) and per-campaign limits.
CREATE FUNCTION crm_platform_usage_value(p_account uuid, p_key text) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_period text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'); result bigint;
BEGIN
  CASE p_key
    WHEN 'seats' THEN
      SELECT (SELECT count(*) FROM account_memberships m WHERE m.account_id = p_account)
        + (SELECT count(*) FROM account_invitations i WHERE i.account_id = p_account AND i.accepted_at IS NULL AND i.expires_at > now())
        INTO result;
    WHEN 'segments' THEN SELECT count(*) INTO result FROM segments s WHERE s.account_id = p_account AND s.archived_at IS NULL;
    WHEN 'lists' THEN SELECT count(*) INTO result FROM contact_lists l WHERE l.account_id = p_account AND l.archived_at IS NULL;
    WHEN 'active_flows' THEN SELECT count(*) INTO result FROM flows f WHERE f.account_id = p_account
      AND (f.status = 'active' OR (f.status = 'draft' AND cardinality(f.test_numbers) > 0));
    WHEN 'active_automations' THEN SELECT count(*) INTO result FROM automations a WHERE a.account_id = p_account AND a.is_active;
    WHEN 'ai_messages' THEN SELECT COALESCE(max(u.value), 0) INTO result FROM usage_counters u
      WHERE u.account_id = p_account AND u.metric = 'ai_messages' AND u.period = v_period;
    WHEN 'ai_tokens_monthly' THEN SELECT COALESCE(max(u.value), 0) INTO result FROM usage_counters u
      WHERE u.account_id = p_account AND u.metric = 'ai_tokens' AND u.period = v_period;
    WHEN 'storage_bytes' THEN SELECT COALESCE(sum(o.byte_size), 0) INTO result FROM media_objects o
      WHERE o.account_id = p_account AND o.deleted_at IS NULL
        AND NOT (o.bucket = 'chat-media' AND o.object_key LIKE 'account-' || o.account_id::text || '/inbound/%');
    WHEN 'whatsapp_numbers' THEN SELECT count(*) INTO result FROM whatsapp_config w WHERE w.account_id = p_account
      AND NOT (w.status = 'disconnected' AND w.access_token = '');
    WHEN 'appointment_staff' THEN SELECT count(*) INTO result FROM appointment_staff st WHERE st.account_id = p_account AND st.archived_at IS NULL;
    WHEN 'instagram_accounts' THEN SELECT count(*) INTO result FROM instagram_accounts ia WHERE ia.account_id = p_account AND ia.status <> 'disconnected';
    WHEN 'contacts' THEN SELECT count(*) INTO result FROM contacts c WHERE c.account_id = p_account;
    WHEN 'integrations' THEN SELECT
        (SELECT count(*) FROM payment_providers x WHERE x.account_id = p_account)
      + (SELECT count(*) FROM shopify_stores x WHERE x.account_id = p_account AND x.uninstalled_at IS NULL)
      + (SELECT count(*) FROM woocommerce_stores x WHERE x.account_id = p_account)
      + (SELECT count(*) FROM meeting_connections x WHERE x.account_id = p_account AND x.status <> 'disconnected')
      + (SELECT count(*) FROM courier_connections x WHERE x.account_id = p_account AND x.status <> 'disconnected')
      + (SELECT count(*) FROM meta_ad_connections x WHERE x.account_id = p_account AND x.status <> 'disconnected')
      INTO result;
    ELSE result := NULL; -- campaign_recipients (per campaign), monthly_active_contacts and messages_monthly (soft)
  END CASE;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION crm_platform_usage_value(uuid, text) FROM PUBLIC;

-- Which workspaces resolve to the LIVE plans row of p_plan: no subscription ->
-- enterprise, non-granting status -> free, granting but not pinned to a version.
CREATE FUNCTION crm_platform_plan_audience(p_plan text) RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.id FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
  WHERE (s.account_id IS NULL AND p_plan = 'enterprise')
     OR (s.status IN ('suspended','cancelled','incomplete') AND p_plan = 'free')
     OR (s.status NOT IN ('suspended','cancelled','incomplete') AND s.plan_id = p_plan AND s.plan_version_id IS NULL)
$$;
REVOKE ALL ON FUNCTION crm_platform_plan_audience(text) FROM PUBLIC;

-- What a plan edit would change: for each tightened finite limit, how many
-- workspaces of the audience above are already over it.
CREATE FUNCTION crm_platform_plan_preview(p_plan text, p_features jsonb, p_limits jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cur plans%ROWTYPE; k text; old_v jsonb; new_v jsonb; tightened jsonb := '[]'::jsonb; affected bigint; over bigint;
BEGIN
  SELECT * INTO cur FROM plans WHERE id = p_plan;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_plan' USING ERRCODE = '22023'; END IF;
  PERFORM crm_platform_validate_plan_terms(p_features, p_limits);
  SELECT count(*) INTO affected FROM crm_platform_plan_audience(p_plan);
  FOREACH k IN ARRAY crm_plan_limit_keys() LOOP
    old_v := cur.limits -> k; new_v := p_limits -> k;
    IF new_v IS NULL OR jsonb_typeof(new_v) = 'null' THEN CONTINUE; END IF;
    IF old_v IS NOT NULL AND jsonb_typeof(old_v) = 'number' AND (old_v::text)::numeric <= (new_v::text)::numeric THEN CONTINUE; END IF;
    IF k IN ('campaign_recipients','monthly_active_contacts','messages_monthly') THEN
      over := NULL;
    ELSE
      SELECT count(*) INTO over FROM crm_platform_plan_audience(p_plan) pa
        WHERE crm_platform_usage_value(pa.account_id, k) > (new_v::text)::numeric;
    END IF;
    tightened := tightened || jsonb_build_object('key', k,
      'current', CASE WHEN old_v IS NULL OR jsonb_typeof(old_v) = 'null' THEN NULL ELSE old_v END,
      'next', new_v, 'over', over);
  END LOOP;
  RETURN jsonb_build_object('plan', p_plan, 'current_version', cur.current_version,
    'affected_workspaces', affected, 'tightened', tightened,
    'preview_hash', crm_platform_plan_hash(p_plan, cur.current_version, p_features, p_limits));
END $$;
REVOKE ALL ON FUNCTION crm_platform_plan_preview(text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_plan_preview(text, jsonb, jsonb) TO bodhinox_platform;

-- Publishes version n+1 and makes it the live row, in one call: lock, validate,
-- enterprise lock, preview-hash check, insert, update, platform audit.
CREATE FUNCTION crm_platform_publish_plan_version(p_plan text, p_features jsonb, p_limits jsonb, p_note text,
  p_admin_email text, p_preview_hash text) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cur plans%ROWTYPE; next_version integer; k text;
BEGIN
  SELECT * INTO cur FROM plans WHERE id = p_plan FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown_plan' USING ERRCODE = '22023'; END IF;
  PERFORM crm_platform_validate_plan_terms(p_features, p_limits);
  IF p_plan = 'enterprise' THEN
    -- The legacy fallback for every workspace without a subscription: never finite, never fewer features.
    IF EXISTS (SELECT 1 FROM jsonb_each(p_limits) e WHERE jsonb_typeof(e.value) <> 'null') THEN
      RAISE EXCEPTION 'plan_locked' USING ERRCODE = '42501';
    END IF;
    FOR k IN SELECT e.key FROM jsonb_each(cur.features) e WHERE e.value = 'true'::jsonb LOOP
      IF COALESCE(p_features -> k, 'false'::jsonb) <> 'true'::jsonb THEN RAISE EXCEPTION 'plan_locked' USING ERRCODE = '42501'; END IF;
    END LOOP;
  END IF;
  IF p_preview_hash IS DISTINCT FROM crm_platform_plan_hash(p_plan, cur.current_version, p_features, p_limits) THEN
    RAISE EXCEPTION 'preview_mismatch' USING ERRCODE = '40001';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO next_version FROM plan_versions WHERE plan_id = p_plan;
  INSERT INTO plan_versions(plan_id, version, features, limits, note, created_by_email)
    VALUES (p_plan, next_version, p_features, p_limits, left(p_note, 500), lower(trim(p_admin_email)));
  UPDATE plans SET features = p_features, limits = p_limits, current_version = next_version WHERE id = p_plan;
  PERFORM crm_platform_audit(p_admin_email, 'plan.publish', NULL, p_plan || ':v' || next_version, p_note,
    jsonb_build_object('plan', p_plan, 'version', next_version, 'previous_version', cur.current_version));
  RETURN next_version;
END $$;
REVOKE ALL ON FUNCTION crm_platform_publish_plan_version(text, jsonb, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_publish_plan_version(text, jsonb, jsonb, text, text, text) TO bodhinox_platform;

-- "Move subscribers to latest version": an explicit, audited admin action per
-- plan (never automatic). Re-pins every granting subscription of the plan to
-- its current version and returns the workspaces on it, so the caller can
-- run the existing downgrade archive for any that are now over a limit.
-- p_version must still be the plan's current version (under the plans row
-- lock), else 'stale_version': a publish in between is never applied unseen.
-- Suspended subscriptions are re-pinned too (the pin is ignored while their
-- status does not grant the plan), so they recover on the new terms. Each moved
-- workspace gets its own audit row in both trails ('plan.subscriber_moved').
-- Returns every GRANTING subscriber already on the target version (moved now
-- or by an earlier move: `changed`), so a repeated move re-runs the archive
-- step for workspaces an interrupted request did not reach.
CREATE FUNCTION crm_platform_move_plan_subscribers(p_plan text, p_version integer, p_admin_email text, p_reason text)
RETURNS TABLE(account_id uuid, changed boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; cur_version integer; moved_ids uuid[]; acct uuid;
BEGIN
  SELECT v.id, p.current_version INTO target, cur_version FROM plans p
    JOIN plan_versions v ON v.plan_id = p.id AND v.version = p.current_version
    WHERE p.id = p_plan FOR UPDATE OF p;
  IF target IS NULL THEN RAISE EXCEPTION 'unknown_plan' USING ERRCODE = '22023'; END IF;
  IF p_reason IS NULL OR char_length(trim(p_reason)) < 10 THEN RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023'; END IF;
  IF p_version IS DISTINCT FROM cur_version THEN RAISE EXCEPTION 'stale_version' USING ERRCODE = '40001'; END IF;
  WITH m AS (
    UPDATE account_subscriptions s SET plan_version_id = target
    WHERE s.plan_id = p_plan AND s.status NOT IN ('cancelled','incomplete')
      AND s.plan_version_id IS DISTINCT FROM target
    RETURNING s.account_id AS moved_account)
  SELECT COALESCE(array_agg(m.moved_account), '{}') INTO moved_ids FROM m;
  FOREACH acct IN ARRAY moved_ids LOOP
    PERFORM crm_platform_audit(p_admin_email, 'plan.subscriber_moved', acct, p_plan, p_reason,
      jsonb_build_object('plan', p_plan, 'version', cur_version, 'plan_version_id', target));
  END LOOP;
  PERFORM crm_platform_audit(p_admin_email, 'plan.move_subscribers', NULL, p_plan, p_reason,
    jsonb_build_object('plan', p_plan, 'version', cur_version, 'plan_version_id', target, 'moved', cardinality(moved_ids)));
  RETURN QUERY SELECT s.account_id, s.account_id = ANY(moved_ids) FROM account_subscriptions s
    WHERE s.plan_id = p_plan AND s.plan_version_id = target AND s.status NOT IN ('suspended','cancelled','incomplete');
END $$;
REVOKE ALL ON FUNCTION crm_platform_move_plan_subscribers(text, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_move_plan_subscribers(text, integer, text, text) TO bodhinox_platform;

-- Read-only plan catalogue for the console (plans, versions, active prices).
CREATE FUNCTION crm_platform_plans() RETURNS TABLE(id text, name text, sort integer, current_version integer,
  features jsonb, limits jsonb, subscribers bigint, pinned_old bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.id, p.name, p.sort, p.current_version, p.features, p.limits,
    (SELECT count(*) FROM account_subscriptions s WHERE s.plan_id = p.id AND s.status NOT IN ('suspended','cancelled','incomplete')),
    (SELECT count(*) FROM account_subscriptions s JOIN plan_versions v ON v.id = s.plan_version_id
      WHERE s.plan_id = p.id AND s.status NOT IN ('suspended','cancelled','incomplete') AND v.version < p.current_version)
  FROM plans p ORDER BY p.sort, p.id
$$;
REVOKE ALL ON FUNCTION crm_platform_plans() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_plans() TO bodhinox_platform;
CREATE FUNCTION crm_platform_plan_versions(p_plan text) RETURNS TABLE(id uuid, version integer, features jsonb, limits jsonb,
  note text, created_by_email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT v.id, v.version, v.features, v.limits, v.note, v.created_by_email, v.created_at
  FROM plan_versions v WHERE v.plan_id = p_plan ORDER BY v.version DESC LIMIT 100
$$;
REVOKE ALL ON FUNCTION crm_platform_plan_versions(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_plan_versions(text) TO bodhinox_platform;
CREATE FUNCTION crm_platform_plan_prices() RETURNS TABLE(plan text, "interval" text, currency text, amount_minor bigint,
  provider_plan_id text, active boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT pp.plan, pp."interval", pp.currency, pp.amount_minor, pp.provider_plan_id, pp.active, pp.created_at, pp.updated_at
  FROM plan_prices pp ORDER BY pp.plan, pp."interval", pp.active DESC, pp.created_at DESC
$$;
REVOKE ALL ON FUNCTION crm_platform_plan_prices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_platform_plan_prices() TO bodhinox_platform;

-- FORCE RLS applies to the definer too: owner SELECT policies on the tables
-- crm_platform_usage_value / crm_platform_plan_preview read, created only where
-- the migration owner has none yet. Tables: account_memberships,
-- account_invitations, segments, contact_lists, flows, automations,
-- usage_counters, media_objects, whatsapp_config, appointment_staff,
-- instagram_accounts, contacts, payment_providers, shopify_stores,
-- woocommerce_stores, meeting_connections, courier_connections,
-- meta_ad_connections, account_subscriptions.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account_memberships','account_invitations','segments','contact_lists','flows','automations',
    'usage_counters','media_objects','whatsapp_config','appointment_staff','instagram_accounts','contacts',
    'payment_providers','shopify_stores','woocommerce_stores','meeting_connections','courier_connections',
    'meta_ad_connections','account_subscriptions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t
        AND current_user::name = ANY(p.roles) AND p.cmd IN ('SELECT','ALL')) THEN
      EXECUTE format('CREATE POLICY platform_owner_read ON %I FOR SELECT TO %I USING (true)', t, current_user);
    END IF;
  END LOOP;
END $$;
-- The publish/move functions update account_subscriptions as the owner.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY platform_owner_pin ON account_subscriptions FOR UPDATE TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
