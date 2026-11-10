-- Add-on purchases whose Razorpay answer was lost are reconciled (audit
-- finding 53).
--
-- add_ons.provider_marker is true when the purchase sent the add-on's own id
-- to Razorpay (in the add-on item's description), so the billing lifecycle
-- sweep can find the Razorpay add-on later and activate the row, or fail it
-- when Razorpay has none. Rows written before this release (false) carry no
-- marker and cannot be matched automatically: each one still pending gets a
-- billing reconciliation item below, for an operator to check against the
-- Razorpay dashboard. Nothing is granted without Razorpay's add-on.
--
-- crm_accounts_with_pending_addons() lists the workspaces the sweep must
-- visit: marked add-ons still pending two minutes after the purchase began
-- (a provider call has a 15-second timeout), for up to eight days (after one
-- day an operator item is opened). Returns account ids only. The owner SELECT
-- policy billing_addon_owner (20261102130000_billing) already covers this
-- definer.
-- Additive.
SET LOCAL lock_timeout = '5s';

ALTER TABLE add_ons ADD COLUMN provider_marker boolean NOT NULL DEFAULT false;

CREATE FUNCTION crm_accounts_with_pending_addons() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT a.account_id FROM add_ons a
  WHERE a.status = 'pending' AND a.provider_marker
    AND a.created_at < now() - interval '2 minutes' AND a.created_at > now() - interval '8 days'
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_pending_addons() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_pending_addons() TO bodhinox_worker;

-- Unmarked add-ons still pending: one operator item each (idempotent per add-on).
INSERT INTO billing_reconciliation_items(account_id, kind, source_ref, detail)
SELECT a.account_id, 'intent_unknown', 'addon:' || a.id::text,
  jsonb_build_object('object', 'add_on', 'add_on_id', a.id, 'add_on_kind', a.kind, 'quantity', a.quantity,
    'amount_minor', a.amount_minor, 'currency', a.currency, 'created_at', a.created_at, 'reason', 'no_marker')
FROM add_ons a WHERE a.status = 'pending' AND NOT a.provider_marker
ON CONFLICT (kind, source_ref) DO NOTHING;
