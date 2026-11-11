-- Stage 5 (5A): Google Sheets connections (5G implements the OAuth routes, the
-- Settings card and the flow step, behind GOOGLE_SHEETS_ENABLED).
--
-- One active connection per workspace. refresh_token_encrypted is the
-- encrypted refresh token: only the worker role can read it (the flow step and
-- token refresh run in the worker). The app role can write it once, on connect
-- (the OAuth callback, admin only), and read every other column for the card,
-- so the token can never reach a browser response. Disconnecting deletes the
-- row. Additive: a new table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE google_sheets_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  google_email text NOT NULL CHECK (char_length(google_email) BETWEEN 3 AND 320 AND position('@' IN google_email) > 1),
  refresh_token_encrypted text NOT NULL CHECK (char_length(refresh_token_encrypted) BETWEEN 1 AND 8192),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','error')),
  -- Audit identity; no foreign key.
  connected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX google_sheets_connections_one_active ON google_sheets_connections (account_id) WHERE status = 'active';

ALTER TABLE google_sheets_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_sheets_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON google_sheets_connections FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY admin_write ON google_sheets_connections FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON google_sheets_connections FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- Every column but the token.
GRANT SELECT (id, account_id, google_email, status, connected_by, created_at, updated_at) ON google_sheets_connections TO bodhinox_app;
GRANT INSERT (account_id, google_email, refresh_token_encrypted, status, connected_by) ON google_sheets_connections TO bodhinox_app;
GRANT UPDATE (status) ON google_sheets_connections TO bodhinox_app;
GRANT DELETE ON google_sheets_connections TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON google_sheets_connections TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON google_sheets_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
