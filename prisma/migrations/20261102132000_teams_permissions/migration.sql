-- Phase 8: teams, per-feature permission restrictions, routing to a team.
--
-- All additive. The one non-additive statement swaps the routing_rules
-- assign_to CHECK for a wider one (adds mode 'team'); every existing row
-- already satisfies the new check.
--
-- Permissions layer on top of roles and can only take away: a row in
-- role_permission_restrictions removes one feature from one role in one
-- workspace. There is no "allow" row, so nothing here can grant a role more
-- than its built-in ceiling (src/lib/auth/permissions.ts). Owners cannot be
-- restricted, and only an owner can restrict admins.

-- ================================================================ teams
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX teams_account_name_key ON teams (account_id, lower(btrim(name)));
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON teams FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON teams FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,DELETE ON teams TO bodhinox_app;
GRANT UPDATE (name) ON teams TO bodhinox_app;
GRANT SELECT ON teams TO bodhinox_worker;

-- A member leaving the workspace leaves every team (membership FK cascade).
CREATE TABLE team_members (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid,
  team_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, team_id, user_id),
  FOREIGN KEY (account_id, team_id) REFERENCES teams(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, user_id) REFERENCES account_memberships(account_id, user_id) ON DELETE CASCADE
);
CREATE INDEX team_members_user_idx ON team_members (account_id, user_id);
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON team_members FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON team_members FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,DELETE ON team_members TO bodhinox_app;
GRANT SELECT ON team_members TO bodhinox_worker;

-- ================================================================ permission restrictions
CREATE TABLE role_permission_restrictions (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','agent','viewer')),
  permission text NOT NULL CHECK (permission ~ '^[a-z_]{1,32}\.[a-z_]{1,32}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, role, permission)
);
ALTER TABLE role_permission_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission_restrictions FORCE ROW LEVEL SECURITY;
-- Every member reads them: a permission check runs as the caller.
CREATE POLICY tenant_read ON role_permission_restrictions FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
-- Admins manage agent/viewer rows; only an owner manages admin rows.
CREATE POLICY tenant_write ON role_permission_restrictions FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin') AND (role<>'admin' OR app_write_allowed('owner')))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin') AND (role<>'admin' OR app_write_allowed('owner')));
GRANT SELECT,INSERT,DELETE ON role_permission_restrictions TO bodhinox_app;
GRANT SELECT ON role_permission_restrictions TO bodhinox_worker;

-- ================================================================ routing to a team
-- {mode:'team', team_id}: round robin over the team's eligible members.
ALTER TABLE routing_rules DROP CONSTRAINT routing_rules_assign_to_check;
ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_assign_to_check
  CHECK (jsonb_typeof(assign_to) = 'object' AND assign_to->>'mode' IN ('member', 'round_robin', 'team')
    AND pg_column_size(assign_to) <= 8192);

-- ================================================================ audit log viewer
-- Its keyset index is built CONCURRENTLY in 20261102132100_audit_logs_created_index.
