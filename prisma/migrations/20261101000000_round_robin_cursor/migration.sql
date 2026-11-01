-- Per-account rotation cursor for round-robin conversation assignment.
-- The row lock on this cursor serializes concurrent assignments for one account.
CREATE TABLE assignment_cursors (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assignment_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_cursors_worker ON assignment_cursors FOR ALL TO bodhinox_worker
  USING(account_id=app_account_id()) WITH CHECK(account_id=app_account_id());
GRANT SELECT,INSERT,UPDATE ON assignment_cursors TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON assignment_cursors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
