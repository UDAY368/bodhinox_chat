-- Phase 11 (CRM-02): an Instagram user is a channel identity of a contact. Every
-- new IGSID gets its own phone-less contact; identities are never matched by
-- phone, name, username, email or picture. A staff decision may move an
-- identity to another contact, and every such move is kept in
-- contact_identity_links (plus an audit_logs row). contacts keeps every column
-- and both unique indexes. Additive.

CREATE TABLE contact_channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'instagram' CHECK (channel IN ('instagram')),
  -- IGSIDs are scoped to one professional account.
  instagram_account_id uuid NOT NULL,
  external_id text NOT NULL CHECK (external_id ~ '^\d{1,32}$'),
  -- Display only, never a match key.
  username text CHECK (char_length(username) <= 64),
  display_name text CHECK (char_length(display_name) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  UNIQUE (account_id, instagram_account_id, external_id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id)
);
CREATE INDEX contact_channel_identities_contact_idx ON contact_channel_identities (account_id, contact_id);

ALTER TABLE contact_channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_channel_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_channel_identities FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Admins move an identity to another contact (staff link/unlink); ingest runs as the worker.
CREATE POLICY admin_update ON contact_channel_identities FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON contact_channel_identities FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON contact_channel_identities TO bodhinox_app;
GRANT UPDATE (contact_id, updated_at) ON contact_channel_identities TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON contact_channel_identities TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_channel_identities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Link history. Contact ids are historical (no FK): the history outlives a deleted contact.
CREATE TABLE contact_identity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  identity_id uuid,
  from_contact_id uuid NOT NULL,
  to_contact_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('link','unlink')),
  basis text NOT NULL DEFAULT 'staff_decision' CHECK (basis IN ('staff_decision')),
  note text CHECK (char_length(note) <= 200),
  decided_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, identity_id) REFERENCES contact_channel_identities(account_id, id)
    ON DELETE SET NULL (identity_id)
);
CREATE INDEX contact_identity_links_identity_idx ON contact_identity_links (account_id, identity_id, created_at DESC);

ALTER TABLE contact_identity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identity_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contact_identity_links FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
-- Append-only: admins record their own decisions; nobody updates or deletes history.
CREATE POLICY admin_insert ON contact_identity_links FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_insert ON contact_identity_links FOR INSERT TO bodhinox_worker
  WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT ON contact_identity_links TO bodhinox_app;
GRANT SELECT, INSERT ON contact_identity_links TO bodhinox_worker;
