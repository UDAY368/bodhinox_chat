-- Stage 5 (5A): folders for the automation list (5F builds the UI and routes).
--
-- One folder list per channel section. Deleting a folder keeps its flows: the
-- foreign key sets flows.folder_id back to NULL (the top level). Agents and
-- above manage folders, as they edit flows; members read them.
--
-- Additive: a new table, and a nullable column on flows with a composite
-- foreign key (a flow can only be filed in a folder of its own workspace),
-- added NOT VALID here and validated by 20261118001200_stage5_validate.
SET LOCAL lock_timeout = '5s';

CREATE TABLE flow_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp','instagram')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60 AND char_length(name) <= 60),
  -- Audit identity; no foreign key, so removing a member never touches folders.
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX flow_folders_name_key ON flow_folders (account_id, channel, lower(name));

ALTER TABLE flow_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON flow_folders FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON flow_folders FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT, DELETE ON flow_folders TO bodhinox_app, bodhinox_worker;
-- Rename only; the channel, author and creation time are fixed.
GRANT UPDATE (name) ON flow_folders TO bodhinox_app, bodhinox_worker;

ALTER TABLE flows ADD COLUMN folder_id uuid;
ALTER TABLE flows ADD CONSTRAINT flows_folder_fkey
  FOREIGN KEY (account_id, folder_id) REFERENCES flow_folders(account_id, id) ON DELETE SET NULL (folder_id) NOT VALID;
