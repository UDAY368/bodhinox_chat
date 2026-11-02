-- Phase 8: add-on purchases and plan downgrades. Additive.
--
-- Add-ons: a purchase is recorded as 'pending' before the provider is called,
-- so an ambiguous provider outcome stays visible for reconciliation instead of
-- being retried or granted. Only 'active' rows raise limits (billing_addon_totals).
--
-- Downgrade: when a workspace has more segments, lists, active flows or active
-- automations than its plan allows, the extra ones are archived (archived_at),
-- never deleted. plan_archives remembers each archived item's prior state so it
-- can be restored exactly when the limits allow again; downgrade_selections
-- holds the admin's choice of what stays active.

-- ---------------------------------------------------------------------------
-- Add-ons gain pending/failed states and the charged amount.
ALTER TABLE add_ons DROP CONSTRAINT add_ons_status_check;
ALTER TABLE add_ons ADD CONSTRAINT add_ons_status_check
  CHECK (status IN ('pending','active','cancelled','failed'));
ALTER TABLE add_ons
  ADD COLUMN amount_minor bigint CHECK (amount_minor > 0),
  ADD COLUMN currency text CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN requested_by uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON add_ons
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---------------------------------------------------------------------------
-- What a downgrade archived, and the state to restore.
--   segments, lists: prior_state 'kept'
--   flows:           'active' or 'draft' (a draft with test numbers)
--   automations:     'active'
CREATE TABLE plan_archives (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('segments','lists','flows','automations')),
  item_id uuid NOT NULL,
  prior_state text NOT NULL CHECK (prior_state IN ('kept','active','draft')),
  plan_id text REFERENCES plans(id),
  archived_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  PRIMARY KEY (account_id, kind, item_id)
);
ALTER TABLE plan_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_archives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON plan_archives FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY tenant_write ON plan_archives FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE ON plan_archives TO bodhinox_app, bodhinox_worker;

-- The admin's choice of what stays active under a smaller plan, per workspace.
-- keep: {"segments": [uuid...], "lists": [...], "flows": [...], "automations": [...]}
CREATE TABLE downgrade_selections (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plans(id),
  keep jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(keep) = 'object'),
  chosen_by uuid,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
ALTER TABLE downgrade_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE downgrade_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON downgrade_selections FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY tenant_write ON downgrade_selections FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE ON downgrade_selections TO bodhinox_app, bodhinox_worker;

-- ---------------------------------------------------------------------------
-- Turning an archived flow or automation back on (within the plan, which the
-- activation routes check) un-archives it, so archived_at always means "off
-- because of the plan".
CREATE FUNCTION billing_clear_archive_automation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND NEW.is_active AND NOT OLD.is_active THEN NEW.archived_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION billing_clear_archive_flow() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND NEW.status <> 'archived' AND OLD.status = 'archived' THEN NEW.archived_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_clear_archive BEFORE UPDATE OF is_active ON automations
  FOR EACH ROW EXECUTE FUNCTION billing_clear_archive_automation();
CREATE TRIGGER billing_clear_archive BEFORE UPDATE OF status ON flows
  FOR EACH ROW EXECUTE FUNCTION billing_clear_archive_flow();
