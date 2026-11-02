-- Phase 8: subscription lifecycle. Additive.
--   billing_intents  every provider call that creates or changes a subscription
--                    is recorded before the call, so an ambiguous outcome
--                    (timeout, 5xx) is reconciled from the provider's state,
--                    never retried blindly and never assumed.
--   notifications    gain the 'billing' type (payment failed, grace ending,
--                    suspended, invoice issued).

-- ---------------------------------------------------------------------------
-- Billing intents. Written by server code through the worker role after the
-- route has checked the admin's session; admins can read their own workspace's
-- rows (pending confirmations in the UI). Never deleted.
CREATE TABLE billing_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('checkout','change_plan','cancel')),
  plan text REFERENCES plans(id),
  "interval" text CHECK ("interval" IN ('month','year')),
  -- change_plan: 'now' (upgrade, prorated by the provider) or 'period_end' (downgrade).
  at text CHECK (at IN ('now','period_end')),
  --   pending    recorded; the provider call is in flight
  --   created    checkout subscription exists; waiting for the buyer to authorise
  --   unknown    the provider's answer was lost; reconciled from its state
  --   rejected   the provider definitely did not act
  --   completed  confirmed by the provider (response, webhook or fetched state)
  --   superseded a later checkout replaced this unpaid one
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','created','unknown','rejected','completed','superseded')),
  provider text NOT NULL DEFAULT 'razorpay' CHECK (provider ~ '^[a-z]{2,20}$'),
  provider_customer_id text CHECK (char_length(provider_customer_id) BETWEEN 1 AND 64),
  provider_subscription_id text CHECK (char_length(provider_subscription_id) BETWEEN 1 AND 64),
  -- The provider's hosted authorisation page, shown only to this workspace's admins.
  short_url text CHECK (short_url IS NULL OR (char_length(short_url) <= 500 AND short_url ~ '^https://')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (kind <> 'checkout' OR (plan IS NOT NULL AND "interval" IS NOT NULL)),
  CHECK (kind <> 'change_plan' OR (plan IS NOT NULL AND "interval" IS NOT NULL AND at IS NOT NULL))
);
-- At most one in-flight or unconfirmed call per kind and workspace, so two
-- clicks (or two admins) can never create two subscriptions or two changes.
CREATE UNIQUE INDEX billing_intents_one_open
  ON billing_intents(account_id, kind) WHERE status IN ('pending','unknown');
CREATE INDEX billing_intents_account_idx ON billing_intents(account_id, created_at DESC);
CREATE INDEX billing_intents_subscription_idx ON billing_intents(provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
ALTER TABLE billing_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON billing_intents FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON billing_intents FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON billing_intents TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON billing_intents TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_intents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Workspaces with a provider call to reconcile: an unknown outcome, or a call
-- still 'pending' after its request could have timed out.
CREATE FUNCTION crm_accounts_with_open_billing_intents() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT i.account_id FROM billing_intents i
  WHERE i.status = 'unknown' OR (i.status = 'pending' AND i.created_at < now() - interval '2 minutes')
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_open_billing_intents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_open_billing_intents() TO bodhinox_worker;
-- FORCE RLS applies to the definer too.
DO $$ BEGIN
  EXECUTE format('CREATE POLICY billing_intents_owner ON billing_intents FOR SELECT TO %I USING (true)', current_user);
END $$;

-- ---------------------------------------------------------------------------
-- Billing notifications. Superset of 20261102120000_inbox_premium; a later
-- replacement must keep every value listed here.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_number_health', 'payment_received',
    'assigned_message', 'mention', 'sla_breach', 'campaign_finished', 'template_rejected', 'billing'));
