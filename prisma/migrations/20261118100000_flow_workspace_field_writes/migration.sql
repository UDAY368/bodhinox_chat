-- Stage 5 (5B): a flow's Actions step may set, or add a number to, an
-- existing non-secret workspace attribute ("set_workspace_field",
-- src/lib/workspace/attribute-write.ts). The engine runs on the worker
-- connection, which could only read workspace_attributes.
--
-- The worker gets UPDATE on the value column only (and updated_at, set by the
-- trigger), through a policy that keeps it inside the tenant and away from
-- secret attributes: it can neither change a secret's ciphertext, flip
-- is_secret, rename a key, insert nor delete. Admins still create and delete
-- attributes through the app role, as before.
-- Additive: one column grant and one policy.
SET LOCAL lock_timeout = '5s';

GRANT UPDATE (value, updated_at) ON workspace_attributes TO bodhinox_worker;

-- additive-exception: a new permissive policy for the worker role only; it adds an UPDATE path and blocks no write (the app role's policies are unchanged).
CREATE POLICY worker_flow_value_update ON workspace_attributes FOR UPDATE TO bodhinox_worker
  USING (account_id = app_account_id() AND NOT is_secret)
  WITH CHECK (account_id = app_account_id() AND NOT is_secret);
