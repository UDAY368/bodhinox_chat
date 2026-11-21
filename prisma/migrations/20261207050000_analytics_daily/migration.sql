SET LOCAL lock_timeout = '5s';

-- Batch 7: daily analytics summary. Additive; two new tables and one worker lookup, no change to an existing table.
-- analytics_daily: one row per workspace per day of the workspace timezone (workspace_inbox_settings.timezone, UTC when unset),
--   written only by the analytics.rollup worker job (src/lib/analytics/daily.ts): yesterday and the two days before it,
--   re-rolled every day so late data lands, as an idempotent upsert. A row exists for every rolled day, even a quiet one,
--   so a missing row means "not rolled yet". Dashboards read it for past days and compute today live.
--   Counts only, plus the first-reply waits of the day in seconds (first_reply_seconds) so a median over any range of days
--   is exact. No message text, contact or phone number.
-- analytics_daily_ai_usage: AI tokens per workspace, day, provider and model, from ai_usage_log. Spend is billing-class, so
--   it is readable by admins only, like ai_usage_log; estimated cost is computed from the price table at read time.
-- crm_accounts_for_analytics_rollup(): the workspaces and their timezone, for the worker's scheduler only.
-- If it aborts on lock_timeout: prisma migrate resolve --rolled-back 20261207050000_analytics_daily.

CREATE TABLE analytics_daily (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  day date NOT NULL,
  messages_in integer NOT NULL DEFAULT 0 CHECK (messages_in >= 0),
  messages_out integer NOT NULL DEFAULT 0 CHECK (messages_out >= 0),
  -- {"whatsapp": {"in": n, "out": n}, "instagram": {...}}
  messages_by_channel jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(messages_by_channel) = 'object'),
  conversations_opened integer NOT NULL DEFAULT 0 CHECK (conversations_opened >= 0),
  conversations_resolved integer NOT NULL DEFAULT 0 CHECK (conversations_resolved >= 0),
  first_reply_count integer NOT NULL DEFAULT 0 CHECK (first_reply_count >= 0),
  first_reply_unanswered integer NOT NULL DEFAULT 0 CHECK (first_reply_unanswered >= 0),
  first_reply_median_seconds integer CHECK (first_reply_median_seconds >= 0),
  first_reply_seconds integer[] NOT NULL DEFAULT '{}',
  ai_replies integer NOT NULL DEFAULT 0 CHECK (ai_replies >= 0),
  ai_handoffs integer NOT NULL DEFAULT 0 CHECK (ai_handoffs >= 0),
  ai_closed integer NOT NULL DEFAULT 0 CHECK (ai_closed >= 0),
  paid_orders integer NOT NULL DEFAULT 0 CHECK (paid_orders >= 0),
  -- {"INR": 123450} in minor units per currency
  revenue_minor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(revenue_minor) = 'object'),
  bookings integer NOT NULL DEFAULT 0 CHECK (bookings >= 0),
  rolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

CREATE TABLE analytics_daily_ai_usage (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  day date NOT NULL,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  prompt_tokens bigint NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  rolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day, provider, model)
);

-- ================================================================ RLS
-- Every member reads the daily counts (the home dashboard); money and AI figures are left out for viewers in code,
-- as orders and payments are hidden from them. Only the worker writes.
ALTER TABLE analytics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON analytics_daily FOR SELECT TO bodhinox_app USING (account_id=app_account_id());
CREATE POLICY worker_write ON analytics_daily FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON analytics_daily TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_daily TO bodhinox_worker;

ALTER TABLE analytics_daily_ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_ai_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON analytics_daily_ai_usage FOR SELECT TO bodhinox_app USING (account_id=app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON analytics_daily_ai_usage FOR ALL TO bodhinox_worker USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON analytics_daily_ai_usage TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_daily_ai_usage TO bodhinox_worker;

-- The scheduler's cross-workspace list: id and the raw timezone setting (validated in code).
CREATE FUNCTION crm_accounts_for_analytics_rollup() RETURNS TABLE(account_id uuid, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.id, s.timezone FROM accounts a LEFT JOIN workspace_inbox_settings s ON s.account_id = a.id
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_analytics_rollup() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_analytics_rollup() TO bodhinox_worker;
