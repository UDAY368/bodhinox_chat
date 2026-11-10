-- Channel separation (Stage 1): which channels a workspace uses.
--
-- One row per (workspace, channel) once an admin picks channels or a channel is
-- connected. A missing row keeps today's behaviour: WhatsApp counts as enabled,
-- Instagram counts as enabled only while an Instagram account is connected
-- (src/lib/channels/workspace.ts). Existing workspaces need no backfill.
--
-- Not a browser resource (not in src/lib/data/contracts.ts): the channel rules
-- (connected implies enabled, no disable while connected, one channel minimum,
-- plan and platform gates) are enforced by PUT /api/account/channels. Every
-- member and the worker read; admins write as themselves; the worker writes
-- from the connect paths (Instagram finishConnect runs as the worker).
--
-- Additive: a new, empty table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE workspace_channels (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  enabled boolean NOT NULL,
  enabled_at timestamptz,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, channel)
);

ALTER TABLE workspace_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON workspace_channels FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON workspace_channels FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin')
    AND (updated_by_user_id IS NULL OR updated_by_user_id = app_user_id()));
CREATE POLICY worker_write ON workspace_channels FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id())
  WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE ON workspace_channels TO bodhinox_app, bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
