SET LOCAL lock_timeout = '5s';

-- Campaign create is guarded by a client request id (Batch 1, campaigns).
-- The wizard makes one id per session and sends it with every create; a retry, a double click
-- or a second request from the same wizard returns the campaign already created instead of a
-- second one. 20261201100100_campaign_client_request_id_idx adds the unique index on
-- (account_id, client_request_id) that create-campaign.ts relies on (ON CONFLICT ... DO NOTHING).
--
-- Additive: one nullable column covered by the table's existing grants and RLS. Server-managed:
-- it is not in the browser contract (src/lib/data/contracts.ts), like retry_request_id.
ALTER TABLE broadcasts ADD COLUMN client_request_id uuid;
