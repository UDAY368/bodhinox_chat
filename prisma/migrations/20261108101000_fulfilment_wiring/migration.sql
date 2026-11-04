-- Phase 9 wiring: plan features and the fulfilment sweep's workspace list.
-- Additive. No permission CHECK change (role_permission_restrictions.permission
-- is a regex) and no webhook_receipts change (provider is unconstrained text).

-- ================================================================ plans
-- Online meetings wherever appointments are on; courier shipping wherever the storefront is.
UPDATE plans SET features = features || jsonb_build_object('online_meetings', features->'appointments')
  WHERE features ? 'appointments';
UPDATE plans SET features = features || jsonb_build_object('courier_shipping', features->'storefront')
  WHERE features ? 'storefront';

-- ================================================================ fulfilment sweep
-- Workspaces with a live Zoom or Shiprocket connection and something to look
-- at: a shipment not yet final, a meeting not yet final (or behind its
-- appointment's version), or a Zoom refresh token near its 90-day expiry.
-- An unconnected workspace is never listed, so it never gets a provider call.
CREATE FUNCTION crm_accounts_for_fulfilment_sweep() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT s.account_id FROM order_shipments s
  JOIN courier_connections c ON c.account_id = s.account_id AND c.status <> 'disconnected'
  WHERE s.create_state IN ('creating','unknown')
     OR s.awb_state IN ('assigning','unknown')
     OR (s.create_state = 'created' AND (s.tracking_rank IS NULL OR s.tracking_rank < 90))
  UNION
  SELECT m.account_id FROM appointment_meetings m
  JOIN meeting_connections c ON c.account_id = m.account_id AND c.status <> 'disconnected'
  JOIN appointments a ON a.account_id = m.account_id AND a.id = m.appointment_id
  WHERE m.sync_state IN ('creating','unknown')
     OR (m.sync_state = 'active' AND (m.synced_version IS NULL OR m.synced_version < a.version))
  UNION
  SELECT c.account_id FROM meeting_connections c
  WHERE c.status = 'active' AND COALESCE(c.refresh_rotated_at, c.connected_at) < now() - interval '80 days'
$$;
REVOKE ALL ON FUNCTION crm_accounts_for_fulfilment_sweep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_for_fulfilment_sweep() TO bodhinox_worker;

-- FORCE RLS applies to the definer's owner too (pattern 20261107102500_commerce_wiring).
-- meeting_connections has meetings_migration_owner; appointments has appointments_migration_owner.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['appointment_meetings','courier_connections','order_shipments']
  LOOP
    EXECUTE format('CREATE POLICY fulfilment_migration_owner ON %I FOR SELECT TO %I USING (true)', t, current_user);
  END LOOP;
END $$;
