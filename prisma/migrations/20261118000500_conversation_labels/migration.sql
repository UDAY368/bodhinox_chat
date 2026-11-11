-- Stage 5 (5A): inbox labels and favourites (5E builds the folders, routes and UI).
--
--   conversation_labels       per workspace, at most 20 (a guard trigger counts
--                             under a per-workspace lock), unique by name without
--                             case, colour from a fixed palette (theme tokens).
--   conversation_label_links  labels applied by hand to conversations of the
--                             same workspace (composite foreign keys).
--   conversation_favourites   per member: each user reads and writes only their
--                             own rows (user_id = app_user_id()).
-- Agents and above manage labels and apply them; members read them.
-- Additive: new tables.
SET LOCAL lock_timeout = '5s';

CREATE TABLE conversation_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 40),
  color text NOT NULL DEFAULT 'gray'
    CHECK (color IN ('gray','red','orange','amber','green','teal','blue','violet','pink')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX conversation_labels_name_key ON conversation_labels (account_id, lower(name));

ALTER TABLE conversation_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversation_labels FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON conversation_labels FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT, DELETE ON conversation_labels TO bodhinox_app, bodhinox_worker;
GRANT UPDATE (name, color) ON conversation_labels TO bodhinox_app, bodhinox_worker;

-- At most 20 labels per workspace, for every role. The transaction lock makes
-- two concurrent inserts count one after the other.
CREATE FUNCTION conversation_labels_cap() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('conversation_labels:' || NEW.account_id::text, 0));
  IF (SELECT count(*) FROM conversation_labels WHERE account_id = NEW.account_id) >= 20 THEN
    RAISE EXCEPTION 'conversation_labels_limit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION conversation_labels_cap() FROM PUBLIC;
CREATE TRIGGER conversation_labels_cap BEFORE INSERT ON conversation_labels
  FOR EACH ROW EXECUTE FUNCTION conversation_labels_cap();

CREATE TABLE conversation_label_links (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  label_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, conversation_id, label_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, label_id) REFERENCES conversation_labels(account_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_label_links_label_idx ON conversation_label_links (account_id, label_id);

ALTER TABLE conversation_label_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_label_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON conversation_label_links FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON conversation_label_links FOR ALL TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent'));
GRANT SELECT, INSERT, DELETE ON conversation_label_links TO bodhinox_app, bodhinox_worker;

CREATE TABLE conversation_favourites (
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id, conversation_id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);

ALTER TABLE conversation_favourites ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_favourites FORCE ROW LEVEL SECURITY;
-- Favourites are personal: a member sees and changes only their own.
CREATE POLICY own_read ON conversation_favourites FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND user_id = app_user_id());
CREATE POLICY own_write ON conversation_favourites FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND user_id = app_user_id())
  WITH CHECK (account_id = app_account_id() AND user_id = app_user_id());
CREATE POLICY worker_all ON conversation_favourites FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, DELETE ON conversation_favourites TO bodhinox_app, bodhinox_worker;
