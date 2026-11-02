-- Phase 8: billing foundation. Platform plan prices, provider subscription
-- fields, GST billing profiles, tax invoices with race-safe numbering, billing
-- webhook events, add-ons, usage counters and archive flags for downgrade.
-- Additive except one mapping: account_subscriptions.status 'canceled' becomes
-- 'cancelled' and the status CHECK gains the billing states.
--
-- Writers: the browser never writes billing state. Subscriptions, invoices,
-- add-ons, events and prices are written by server code through the worker
-- role, only from a verified provider event or a reconciliation fetch. Billing
-- profiles are written by workspace admins. Downgrade archives (archived_at),
-- never deletes.

-- ---------------------------------------------------------------------------
-- Plan prices: a platform catalogue (no tenant data). Every signed-in user may
-- read it; only server code acting for a platform admin (PLATFORM_ADMIN_EMAILS)
-- or the env seed writes it, through the worker role.
CREATE TABLE plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan text NOT NULL REFERENCES plans(id),
  "interval" text NOT NULL CHECK ("interval" IN ('month','year')),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  provider text NOT NULL DEFAULT 'razorpay' CHECK (provider ~ '^[a-z]{2,20}$'),
  provider_plan_id text NOT NULL CHECK (char_length(provider_plan_id) BETWEEN 1 AND 64),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan, "interval", currency, provider)
);
GRANT SELECT ON plan_prices TO bodhinox_app, bodhinox_worker;
GRANT INSERT, UPDATE ON plan_prices TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plan_prices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Account subscriptions gain the provider's ids and lifecycle fields.
ALTER TABLE account_subscriptions
  ADD COLUMN provider text CHECK (provider ~ '^[a-z]{2,20}$'),
  ADD COLUMN provider_customer_id text CHECK (char_length(provider_customer_id) BETWEEN 1 AND 64),
  ADD COLUMN provider_subscription_id text CHECK (char_length(provider_subscription_id) BETWEEN 1 AND 64),
  ADD COLUMN "interval" text CHECK ("interval" IN ('month','year')),
  ADD COLUMN current_period_start timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- A downgrade chosen for the end of the current term.
  ADD COLUMN scheduled_plan text REFERENCES plans(id),
  ADD COLUMN grace_ends_at timestamptz,
  ADD COLUMN suspended_at timestamptz;
CREATE UNIQUE INDEX account_subscriptions_provider_sub_key
  ON account_subscriptions(provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

-- Map the old spelling. FORCE RLS would hide the rows from the migration owner,
-- so it is lifted only for this statement and restored before commit.
ALTER TABLE account_subscriptions DROP CONSTRAINT account_subscriptions_status_check;
ALTER TABLE account_subscriptions NO FORCE ROW LEVEL SECURITY;
UPDATE account_subscriptions SET status = 'cancelled' WHERE status = 'canceled';
ALTER TABLE account_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE account_subscriptions ADD CONSTRAINT account_subscriptions_status_check
  CHECK (status IN ('trialing','active','past_due','grace','suspended','cancelled','incomplete'));

-- The worker applies verified provider events, in tenant scope.
CREATE POLICY worker_write ON account_subscriptions FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT INSERT, UPDATE ON account_subscriptions TO bodhinox_worker;

-- The cross-tenant lookups billing needs: a provider subscription id -> its
-- workspace, and the workspaces whose subscription has a time-based transition.
CREATE FUNCTION crm_resolve_billing_subscription(p_provider text, p_subscription_id text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM account_subscriptions s
  WHERE s.provider = p_provider AND s.provider_subscription_id = p_subscription_id
$$;
REVOKE ALL ON FUNCTION crm_resolve_billing_subscription(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_resolve_billing_subscription(text, text) TO bodhinox_worker;
CREATE FUNCTION crm_accounts_for_billing_sweep() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM account_subscriptions s
  WHERE s.status IN ('trialing','past_due','grace','incomplete')
     OR s.cancel_at_period_end OR s.scheduled_plan IS NOT NULL
     -- An active period that ended without a reported renewal (a lost
     -- charged/pending/halted/cancelled webhook): fetch the provider's state.
     -- '1 day' must equal RENEWAL_ALLOWANCE_MS in src/lib/billing/lifecycle.ts.
     OR (s.status = 'active' AND s.provider_subscription_id IS NOT NULL
         AND s.current_period_end < now() - interval '1 day')
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_billing_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_billing_sweep() TO bodhinox_worker;
-- FORCE RLS applies to the definer too (same pattern as migration_owner).
DO $$ BEGIN
  EXECUTE format('CREATE POLICY billing_resolve_owner ON account_subscriptions FOR SELECT TO %I USING (true)', current_user);
END $$;

-- ---------------------------------------------------------------------------
-- GST billing profile: who the invoice is addressed to. Admins write it.
CREATE TABLE billing_profiles (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  legal_name text NOT NULL CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  -- 15 characters: state code, PAN, entity number, 'Z', checksum. The checksum is
  -- verified in application code (lib/billing/gst validateGstin).
  gstin text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  address_line1 text NOT NULL CHECK (char_length(address_line1) BETWEEN 1 AND 200),
  address_line2 text CHECK (char_length(address_line2) <= 200),
  city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 100),
  -- GST state code ('29' Karnataka, '97' other territory); NULL outside India.
  state_code text CHECK (state_code ~ '^[0-9]{2}$'),
  postal_code text NOT NULL CHECK (char_length(postal_code) BETWEEN 1 AND 20),
  country text NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$'),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email LIKE '%@%'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (country <> 'IN' OR state_code IS NOT NULL),
  CHECK (gstin IS NULL OR country = 'IN')
);
ALTER TABLE billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON billing_profiles FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY tenant_write ON billing_profiles FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE ON billing_profiles TO bodhinox_app;
GRANT SELECT ON billing_profiles TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Invoice numbers: one gapless counter per Indian financial year (Apr-Mar).
-- The upsert takes a row lock, so concurrent issuers serialise and a rolled
-- back invoice also rolls back its number. Platform-level, worker only.
CREATE TABLE invoice_sequences (
  financial_year text PRIMARY KEY CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_value bigint NOT NULL CHECK (last_value > 0)
);
GRANT SELECT, INSERT, UPDATE ON invoice_sequences TO bodhinox_worker;

-- Tax invoices. Amounts are integer paise. Issued by the worker only; members
-- read them (download is restricted to admins in the route); never deleted
-- (status 'void' instead).
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE CHECK (number ~ '^[A-Z]{1,6}/[0-9]{4}-[0-9]{2}/[0-9]{6,}$'),
  provider text CHECK (provider ~ '^[a-z]{2,20}$'),
  provider_invoice_id text CHECK (char_length(provider_invoice_id) BETWEEN 1 AND 64),
  provider_payment_id text CHECK (char_length(provider_payment_id) BETWEEN 1 AND 64),
  period_start timestamptz,
  period_end timestamptz,
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  cgst_minor bigint NOT NULL DEFAULT 0 CHECK (cgst_minor >= 0),
  sgst_minor bigint NOT NULL DEFAULT 0 CHECK (sgst_minor >= 0),
  igst_minor bigint NOT NULL DEFAULT 0 CHECK (igst_minor >= 0),
  total_minor bigint NOT NULL,
  place_of_supply_state_code text CHECK (place_of_supply_state_code ~ '^[0-9]{2}$'),
  gstin_snapshot text CHECK (char_length(gstin_snapshot) = 15),
  billing_address_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(line_items) = 'array'),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','paid','void')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  pdf_object_key text CHECK (char_length(pdf_object_key) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (total_minor = subtotal_minor + cgst_minor + sgst_minor + igst_minor),
  -- Intra-state (CGST+SGST) or inter-state (IGST), never both.
  CHECK (igst_minor = 0 OR (cgst_minor = 0 AND sgst_minor = 0)),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
-- One invoice per provider invoice, so a replayed event cannot issue twice.
CREATE UNIQUE INDEX invoices_provider_invoice_key ON invoices(provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
CREATE INDEX invoices_account_issued_idx ON invoices(account_id, issued_at DESC);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON invoices FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON invoices FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON invoices TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON invoices TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- Billing webhook events: one row per provider event id (idempotency), with a
-- minimised payload (ids, statuses, amounts; no card or customer details).
-- Worker only. account_id is NULL until the event is matched to a workspace.
CREATE TABLE billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z]{2,20}$'),
  event_id text NOT NULL UNIQUE CHECK (char_length(event_id) BETWEEN 1 AND 128),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text CHECK (char_length(error) <= 500)
);
CREATE INDEX billing_events_unprocessed_idx ON billing_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX billing_events_account_idx ON billing_events(account_id, received_at DESC) WHERE account_id IS NOT NULL;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_all ON billing_events FOR ALL TO bodhinox_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON billing_events TO bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Add-ons bought on top of a plan; each active add-on raises one limit.
CREATE TABLE add_ons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('extra_seats','ai_messages','extra_numbers')),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  provider_addon_id text CHECK (char_length(provider_addon_id) BETWEEN 1 AND 64),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX add_ons_provider_key ON add_ons(provider_addon_id) WHERE provider_addon_id IS NOT NULL;
CREATE INDEX add_ons_account_active_idx ON add_ons(account_id) WHERE status = 'active';
ALTER TABLE add_ons ENABLE ROW LEVEL SECURITY;
ALTER TABLE add_ons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON add_ons FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON add_ons FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON add_ons TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON add_ons TO bodhinox_worker;
-- Entitlements are computed for every member, but add-on rows are admin-only:
-- this returns only the per-kind totals for the transaction's own workspace.
CREATE FUNCTION billing_addon_totals() RETURNS TABLE(kind text, quantity bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.kind, sum(a.quantity)::bigint FROM add_ons a
  WHERE a.account_id = app_account_id() AND a.status = 'active'
    AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
  GROUP BY a.kind
$$;
REVOKE ALL ON FUNCTION billing_addon_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_addon_totals() TO bodhinox_app, bodhinox_worker;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY billing_addon_owner ON add_ons FOR SELECT TO %I USING (true)', current_user);
END $$;

-- ---------------------------------------------------------------------------
-- Metered usage per calendar month in India time ('YYYY-MM', Asia/Kolkata).
-- Server code adds to a counter only through billing_increment_usage, an
-- atomic upsert that is safe under concurrency; the workspace comes from the
-- transaction's tenant setting, never from an argument.
CREATE TABLE usage_counters (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('ai_messages','monthly_active_contacts','storage_bytes')),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, metric, period)
);
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON usage_counters FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_insert ON usage_counters FOR INSERT TO bodhinox_app, bodhinox_worker
  WITH CHECK (account_id = app_account_id());
CREATE POLICY tenant_update ON usage_counters FOR UPDATE TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON usage_counters TO bodhinox_app, bodhinox_worker;
GRANT INSERT (account_id, metric, period, value), UPDATE (value, updated_at) ON usage_counters TO bodhinox_app, bodhinox_worker;

CREATE FUNCTION billing_increment_usage(p_metric text, p_by bigint, p_at timestamptz DEFAULT now())
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result bigint;
BEGIN
  IF app_account_id() IS NULL THEN RAISE EXCEPTION 'tenant scope required'; END IF;
  IF p_by IS NULL OR p_by <= 0 THEN RAISE EXCEPTION 'increment must be positive'; END IF;
  INSERT INTO usage_counters AS u (account_id, metric, period, value)
  VALUES (app_account_id(), p_metric, to_char(p_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM'), p_by)
  ON CONFLICT (account_id, metric, period)
    DO UPDATE SET value = u.value + EXCLUDED.value, updated_at = now()
  RETURNING u.value INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION billing_increment_usage(text, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_increment_usage(text, bigint, timestamptz) TO bodhinox_app, bodhinox_worker;

-- ---------------------------------------------------------------------------
-- New plan limits, seeded UNLIMITED (JSON null) on every plan until the owner
-- confirms real values: existing workspaces on free/basic/pro must not start
-- being refused AI replies, uploads or numbers at deploy. The gates and counters
-- are live, so setting a number later (docs/deployment/railway.md, "Plan
-- limits") takes effect at once. storage_bytes is in bytes.
UPDATE plans SET limits = limits || '{"ai_messages":null,"monthly_active_contacts":null,"storage_bytes":null,"whatsapp_numbers":null}'::jsonb
  WHERE id IN ('free','basic','pro');

-- ---------------------------------------------------------------------------
-- Downgrade archives what no longer fits the plan; it never deletes.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE contact_lists ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS archived_at timestamptz;
