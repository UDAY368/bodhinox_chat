-- Store Phase 5: more couriers (Delhivery, Shipway) next to Shiprocket.
-- Additive and relaxing only: every existing row stays valid. A workspace may hold one live connection PER provider
-- (it was one live connection in total), Delhivery and Shipway keep their credentials in the same encrypted columns as
-- Shiprocket (api_email = the Delhivery client name or the Shipway username, api_password_enc = the API token or
-- licence key), and a masked hint of the secret is the only part the app role may read back.
SET LOCAL lock_timeout = '5s';

-- ================================================================ connections
ALTER TABLE courier_connections DROP CONSTRAINT IF EXISTS courier_connections_provider_check; -- additive-exception: the check is re-added at once in the next statement, only wider; no row becomes invalid
ALTER TABLE courier_connections ADD CONSTRAINT courier_connections_provider_check
  CHECK (provider IN ('shiprocket','delhivery','shipway')); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
-- Shiprocket's API user is an email; a Delhivery client name or a Shipway username need not be.
ALTER TABLE courier_connections DROP CONSTRAINT IF EXISTS courier_connections_api_email_check; -- additive-exception: the check is re-added at once in the next statement, only wider; no row becomes invalid
ALTER TABLE courier_connections ADD CONSTRAINT courier_connections_api_email_check
  CHECK (char_length(api_email) BETWEEN 1 AND 254 AND (provider <> 'shiprocket' OR position('@' in api_email) > 1)); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
ALTER TABLE courier_connections ADD COLUMN secret_hint text
  CHECK (secret_hint IS NULL OR char_length(secret_hint) <= 12); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
GRANT SELECT (secret_hint) ON courier_connections TO bodhinox_app;

DROP INDEX IF EXISTS courier_connections_live_account_key; -- additive-exception: replaced by the per-provider index below, which is looser (one live connection per courier)
CREATE UNIQUE INDEX courier_connections_live_provider_key ON courier_connections (account_id, provider)
  WHERE status <> 'disconnected'; -- additive-exception: courier_connections holds at most a few rows per workspace, so the build is instant

-- ================================================================ shipments
ALTER TABLE order_shipments DROP CONSTRAINT IF EXISTS order_shipments_provider_check; -- additive-exception: the check is re-added at once in the next statement, only wider; no row becomes invalid
ALTER TABLE order_shipments ADD CONSTRAINT order_shipments_provider_check
  CHECK (provider IN ('shiprocket','delhivery','shipway')); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
-- Delhivery keeps its waybill and Shipway our reference in these two columns (Shiprocket's stay numeric ids).
ALTER TABLE order_shipments DROP CONSTRAINT IF EXISTS order_shipments_sr_order_id_check; -- additive-exception: the check is re-added at once in the next statement, only wider; no row becomes invalid
ALTER TABLE order_shipments ADD CONSTRAINT order_shipments_sr_order_id_check
  CHECK (sr_order_id IS NULL OR sr_order_id ~ '^[A-Za-z0-9_-]{1,40}$'); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
ALTER TABLE order_shipments DROP CONSTRAINT IF EXISTS order_shipments_sr_shipment_id_check; -- additive-exception: the check is re-added at once in the next statement, only wider; no row becomes invalid
ALTER TABLE order_shipments ADD CONSTRAINT order_shipments_sr_shipment_id_check
  CHECK (sr_shipment_id IS NULL OR sr_shipment_id ~ '^[A-Za-z0-9_-]{1,40}$'); -- additive-exception: a widened check every existing row already passes; these tables are small (a few connections, one row per parcel), so the scan is short
