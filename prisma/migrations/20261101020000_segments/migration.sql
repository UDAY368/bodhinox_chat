-- Saved audience segments: a named filter (lib/audience/filter) resolved
-- live against contacts. Any member reads; agents and above write.
CREATE TABLE segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  filter jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  UNIQUE (account_id, id)
);
CREATE INDEX segments_tenant_idx ON segments(account_id);
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON segments FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON segments FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT,UPDATE,DELETE ON segments TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON segments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
