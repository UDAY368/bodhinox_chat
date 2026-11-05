-- Phase 14: idempotent metering and AI reservation, plus usage notices.
--
-- usage_events is a per-workspace ledger with one row per (metric, source
-- event): a replay of the same inbound message, flow step, task or request
-- meters once. A reservation holds quota before a provider call and stops
-- counting by itself after 15 minutes, so correctness never depends on a
-- sweep. The four functions are SECURITY INVOKER and take the workspace from
-- app_account_id() (like billing_increment_usage), so one tenant can never
-- meter another; RLS applies to every statement they run.
--
-- usage_notices records the 80% / 100% warnings once per limit, period and
-- threshold; only finite limits emit them, so nothing fires for existing
-- workspaces (all of which are unlimited on the new keys). Additive.
SET LOCAL lock_timeout = '5s';

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('ai_messages','ai_tokens')),
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 200),
  -- IST calendar month, the same format as usage_counters.period / usagePeriod().
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  quantity bigint NOT NULL CHECK (quantity > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled','released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (account_id, metric, source_key),
  CHECK (state <> 'settled' OR settled_at IS NOT NULL)
);
CREATE INDEX usage_events_reserved_idx ON usage_events(account_id, metric, period) WHERE state = 'reserved';
CREATE INDEX usage_events_housekeeping_idx ON usage_events(reserved_at) WHERE state IN ('settled','released');
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_usage ON usage_events FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON usage_events TO bodhinox_app, bodhinox_worker;
-- Housekeeping removes settled/released rows older than 13 months (worker, tenant scope).
GRANT DELETE ON usage_events TO bodhinox_worker;

CREATE TABLE usage_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  limit_key text NOT NULL CHECK (limit_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- 'YYYY-MM' for monthly keys; 'current' for count keys (one notice until the period changes).
  period text NOT NULL CHECK (period ~ '^([0-9]{4}-(0[1-9]|1[0-2])|current)$'),
  threshold smallint NOT NULL CHECK (threshold IN (80, 100)),
  limit_value bigint NOT NULL CHECK (limit_value >= 0),
  used_value bigint NOT NULL CHECK (used_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, limit_key, period, threshold)
);
ALTER TABLE usage_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON usage_notices FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON usage_notices FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id = app_account_id());
GRANT SELECT ON usage_notices TO bodhinox_app, bodhinox_worker;
GRANT INSERT ON usage_notices TO bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Reserve p_qty of p_metric for one source event. Returns:
--   'reserved'   the reservation is held (new, or the same key already held)
--   'replay'     this source event was already settled: do not call the provider again
--   'over_limit' p_limit is set and used + live reservations + p_qty would exceed it
CREATE FUNCTION billing_reserve_usage(p_metric text, p_source_key text, p_qty bigint, p_limit bigint DEFAULT NULL)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE account uuid := app_account_id(); v_period text := to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM');
  existing usage_events%ROWTYPE; has_row boolean; used bigint; held bigint;
BEGIN
  IF account IS NULL THEN RAISE EXCEPTION 'tenant scope required'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF p_limit IS NOT NULL AND p_limit < 0 THEN RAISE EXCEPTION 'limit must not be negative'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(account::text || ':' || p_metric));
  SELECT * INTO existing FROM usage_events e WHERE e.account_id = account AND e.metric = p_metric AND e.source_key = p_source_key FOR UPDATE;
  has_row := FOUND;
  IF has_row AND existing.state = 'settled' THEN RETURN 'replay'; END IF;
  IF has_row AND existing.state = 'reserved' AND existing.reserved_at > now() - interval '15 minutes' THEN RETURN 'reserved'; END IF;
  IF p_limit IS NOT NULL THEN
    -- One statement, one snapshot: a settle committing between two separate
    -- reads would be missing from both the counter and the holds.
    SELECT (SELECT COALESCE(max(u.value), 0) FROM usage_counters u
              WHERE u.account_id = account AND u.metric = p_metric AND u.period = v_period),
           (SELECT COALESCE(sum(e.quantity), 0) FROM usage_events e
              WHERE e.account_id = account AND e.metric = p_metric AND e.period = v_period AND e.state = 'reserved'
                AND e.reserved_at > now() - interval '15 minutes' AND e.source_key <> p_source_key)
      INTO used, held;
    IF used + held + p_qty > p_limit THEN RETURN 'over_limit'; END IF;
  END IF;
  IF has_row THEN
    -- A released or expired reservation of the same key: hold it again.
    UPDATE usage_events SET state = 'reserved', quantity = p_qty, period = v_period, reserved_at = now(), settled_at = NULL
      WHERE id = existing.id;
  ELSE
    INSERT INTO usage_events(account_id, metric, source_key, period, quantity, state)
      VALUES (account, p_metric, p_source_key, v_period, p_qty, 'reserved');
  END IF;
  RETURN 'reserved';
END $$;

-- Settles a reservation (reserved or released -> settled) and adds p_actual to
-- the period counter exactly once. Settled -> no-op (returns false).
CREATE FUNCTION billing_settle_usage(p_metric text, p_source_key text, p_actual bigint)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE account uuid := app_account_id(); changed integer;
BEGIN
  IF account IS NULL THEN RAISE EXCEPTION 'tenant scope required'; END IF;
  IF p_actual IS NULL OR p_actual < 0 THEN RAISE EXCEPTION 'quantity must not be negative'; END IF;
  UPDATE usage_events SET state = 'settled', settled_at = now(), quantity = GREATEST(p_actual, 1)
    WHERE account_id = account AND metric = p_metric AND source_key = p_source_key AND state IN ('reserved','released');
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 THEN RETURN false; END IF;
  IF p_actual > 0 THEN PERFORM billing_increment_usage(p_metric, p_actual); END IF;
  RETURN true;
END $$;

-- Releases a held reservation when the provider definitely did not bill.
CREATE FUNCTION billing_release_usage(p_metric text, p_source_key text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE account uuid := app_account_id(); changed integer;
BEGIN
  IF account IS NULL THEN RAISE EXCEPTION 'tenant scope required'; END IF;
  UPDATE usage_events SET state = 'released'
    WHERE account_id = account AND metric = p_metric AND source_key = p_source_key AND state = 'reserved';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END $$;

-- Records usage that needed no reservation (unlimited fast path): inserted
-- settled once per source event; the counter grows only when inserted.
CREATE FUNCTION billing_record_usage(p_metric text, p_source_key text, p_qty bigint)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE account uuid := app_account_id(); inserted integer;
BEGIN
  IF account IS NULL THEN RAISE EXCEPTION 'tenant scope required'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  INSERT INTO usage_events(account_id, metric, source_key, period, quantity, state, settled_at)
    VALUES (account, p_metric, p_source_key, to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'), p_qty, 'settled', now())
    ON CONFLICT (account_id, metric, source_key) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN RETURN false; END IF;
  PERFORM billing_increment_usage(p_metric, p_qty);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION billing_reserve_usage(text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_settle_usage(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_release_usage(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_record_usage(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_reserve_usage(text, text, bigint, bigint), billing_settle_usage(text, text, bigint),
  billing_release_usage(text, text), billing_record_usage(text, text, bigint) TO bodhinox_app, bodhinox_worker;

-- Housekeeping: the workspaces with ledger rows older than 13 months to remove.
CREATE FUNCTION crm_accounts_with_usage_housekeeping_due() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT e.account_id FROM usage_events e
  WHERE e.state IN ('settled','released') AND e.reserved_at < now() - interval '13 months'
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_usage_housekeeping_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_usage_housekeeping_due() TO bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY usage_housekeeping_owner ON usage_events FOR SELECT TO %I USING (true)', current_user);
END $$;
