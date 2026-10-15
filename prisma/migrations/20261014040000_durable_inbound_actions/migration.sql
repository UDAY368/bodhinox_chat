-- Durable, tenant-scoped stage checkpoints for post-ingestion actions.
-- An interrupted dispatching stage requires reconciliation, never a blind send replay.
CREATE TABLE inbound_action_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'dispatching' CHECK(status IN ('dispatching','completed','uncertain')),
  context jsonb NOT NULL DEFAULT '{}',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,message_id,stage),
  CONSTRAINT inbound_steps_message_tenant_fkey FOREIGN KEY(account_id,message_id)
    REFERENCES messages(account_id,id) ON DELETE CASCADE
);
CREATE INDEX inbound_steps_review_idx ON inbound_action_steps(account_id,status,updated_at);
ALTER TABLE inbound_action_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_action_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY inbound_steps_worker ON inbound_action_steps FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());
CREATE POLICY inbound_steps_admin_read ON inbound_action_steps FOR SELECT TO bodhinox_app
  USING(account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE,DELETE ON inbound_action_steps TO bodhinox_worker;
GRANT SELECT ON inbound_action_steps TO bodhinox_app;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON inbound_action_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
