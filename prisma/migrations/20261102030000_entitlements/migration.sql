-- Phase 8.1: plans and entitlements. Additive.
-- A workspace without a subscription row is on the unrestricted 'enterprise'
-- plan, so introducing plans changes nothing for existing workspaces until a
-- subscription (from billing, later) assigns a smaller one.

CREATE TABLE plans (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,31}$'),
  name text NOT NULL,
  -- Boolean switches, e.g. {"campaign_scheduling": true}.
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Numeric caps; a missing key or JSON null means unlimited.
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort integer NOT NULL DEFAULT 0
);
INSERT INTO plans(id, name, sort, features, limits) VALUES
  ('free', 'Free', 0, '{}',
   '{"seats":1,"segments":3,"lists":3,"campaign_recipients":250,"active_flows":1,"active_automations":3}'),
  ('basic', 'Basic', 1,
   '{"campaign_scheduling":true,"contact_export":true}',
   '{"seats":3,"segments":20,"lists":20,"campaign_recipients":10000,"active_flows":5,"active_automations":20}'),
  ('pro', 'Pro', 2,
   '{"campaign_scheduling":true,"contact_export":true,"api_campaigns":true,"click_tracking":true,"retargeting":true,"workspace_attributes":true}',
   '{"seats":10,"segments":100,"lists":100,"campaign_recipients":50000,"active_flows":50,"active_automations":100}'),
  ('enterprise', 'Enterprise', 3,
   '{"campaign_scheduling":true,"contact_export":true,"api_campaigns":true,"click_tracking":true,"retargeting":true,"workspace_attributes":true}',
   '{}');
-- A global catalogue (no tenant data): readable by the runtime roles, written only by migrations.
GRANT SELECT ON plans TO bodhinox_app, bodhinox_worker;

CREATE TABLE account_subscriptions (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE account_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_subscriptions FORCE ROW LEVEL SECURITY;
-- Members can see their plan; changes come from operators (and billing, later), never the browser.
CREATE POLICY tenant_read ON account_subscriptions FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
GRANT SELECT ON account_subscriptions TO bodhinox_app, bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
