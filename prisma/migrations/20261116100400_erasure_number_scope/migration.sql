-- Per-contact erasure, review fix (audit finding 39): a WhatsApp number can move between
-- workspaces (a disconnected row is kept, and another workspace may connect the same
-- phone_number_id). webhook_receipts carry no workspace id, so deleting the receipts of a
-- number this workspace once held could delete another workspace's raw copies.
-- crm_erasure_phone_number_ids() returns only the caller's phone_number_ids that no other
-- workspace has a row for; receipts on shared numbers are left to the 30-day retention sweep.
-- The caller's workspace comes from its tenant setting (withTenant), never from an argument.
-- Additive: a new function only.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION crm_erasure_phone_number_ids() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w.phone_number_id FROM whatsapp_config w
  WHERE w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND w.phone_number_id <> ''
    AND NOT EXISTS (SELECT 1 FROM whatsapp_config o
      WHERE o.phone_number_id = w.phone_number_id AND o.account_id <> w.account_id)
$$;
REVOKE ALL ON FUNCTION crm_erasure_phone_number_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_erasure_phone_number_ids() TO bodhinox_worker;
