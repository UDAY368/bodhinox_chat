-- Phase 1c: tag categories, static contact lists and workspace attributes.
-- All additive; existing rows need no backfill.

-- Optional grouping label for tags (admin-managed like the tag itself).
ALTER TABLE tags ADD COLUMN category text CHECK (char_length(category) BETWEEN 1 AND 40);

-- Static lists: hand-picked contacts. Any member reads; agents and above write.
CREATE TABLE contact_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, name),
  UNIQUE (account_id, id)
);
CREATE TABLE contact_list_members (
  account_id uuid NOT NULL,
  list_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id),
  FOREIGN KEY (account_id, list_id) REFERENCES contact_lists(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_list_members_contact_idx ON contact_list_members(account_id, contact_id);

ALTER TABLE contact_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_lists FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON contact_lists FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT,UPDATE,DELETE ON contact_lists TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE contact_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_list_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_list_members FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON contact_list_members FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
GRANT SELECT,INSERT,DELETE ON contact_list_members TO bodhinox_app,bodhinox_worker;

-- Workspace (global) attributes, used as {{workspace.key}} in flow and
-- automation text. A secret keeps only value_encrypted (lib/whatsapp/encryption)
-- and is never returned to the browser. Members and the worker read; admins write.
CREATE TABLE workspace_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  value text CHECK (char_length(value) <= 1000),
  value_encrypted text,
  is_secret boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, key),
  CHECK ((is_secret AND value IS NULL AND value_encrypted IS NOT NULL)
    OR (NOT is_secret AND value IS NOT NULL AND value_encrypted IS NULL))
);
ALTER TABLE workspace_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_attributes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON workspace_attributes FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON workspace_attributes FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE,DELETE ON workspace_attributes TO bodhinox_app;
GRANT SELECT ON workspace_attributes TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON workspace_attributes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
