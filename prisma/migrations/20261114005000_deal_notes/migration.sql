-- Deal notes: author-stamped team notes on a deal (the Sales pipeline deal
-- panel). Each note is a short internal text written by a member; it is never
-- sent to the customer. Deleting the deal deletes its notes.
--
-- Additive: a new table with forced row-level security. Members (agent and
-- above) add notes; the author or an admin deletes one; viewers and the worker
-- read. Notes are not edited (delete and write again).
SET LOCAL lock_timeout = '5s';

CREATE TABLE deal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000 AND body = btrim(body)),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, deal_id) REFERENCES deals(account_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_notes_deal_idx ON deal_notes(account_id, deal_id, created_at DESC);

ALTER TABLE deal_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON deal_notes FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_insert ON deal_notes FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND created_by = app_user_id());
CREATE POLICY tenant_delete ON deal_notes FOR DELETE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent')
    AND (created_by = app_user_id() OR app_write_allowed('admin')));
GRANT SELECT, INSERT, DELETE ON deal_notes TO bodhinox_app;
GRANT SELECT ON deal_notes TO bodhinox_worker;
