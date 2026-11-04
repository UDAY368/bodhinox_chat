-- Phase 11: comment-to-private-reply rules and the comments they matched.
-- No comment text is stored: keyword matching happens in the job from the
-- webhook receipt. One private reply per comment, enforced by the unique key.
-- Additive.

CREATE TABLE instagram_comment_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  instagram_account_id uuid NOT NULL,
  -- NULL: any post or reel of the account.
  media_id text CHECK (media_id ~ '^\d{1,32}$'),
  -- Lower-cased; empty: any comment.
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 20),
  reply_text text NOT NULL CHECK (octet_length(reply_text) BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id)
);
CREATE INDEX instagram_comment_rules_account_idx ON instagram_comment_rules (account_id, instagram_account_id);

ALTER TABLE instagram_comment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_comment_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instagram_comment_rules FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY admin_write ON instagram_comment_rules FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_write ON instagram_comment_rules FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON instagram_comment_rules TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON instagram_comment_rules TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_comment_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE instagram_comment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  instagram_account_id uuid NOT NULL,
  comment_id text NOT NULL CHECK (comment_id ~ '^\d{1,32}$'),
  media_id text CHECK (media_id ~ '^\d{1,32}$'),
  from_igsid text CHECK (from_igsid ~ '^\d{1,32}$'),
  rule_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  private_reply_status text NOT NULL DEFAULT 'none'
    CHECK (private_reply_status IN ('none','queued','sent','unknown','expired','rejected','no_rule')),
  private_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  -- One private reply per comment.
  UNIQUE (instagram_account_id, comment_id),
  FOREIGN KEY (account_id, instagram_account_id) REFERENCES instagram_accounts(account_id, id),
  FOREIGN KEY (account_id, rule_id) REFERENCES instagram_comment_rules(account_id, id) ON DELETE SET NULL (rule_id)
);
-- The hourly private-reply rate check counts sent/unknown replies per account.
CREATE INDEX instagram_comment_events_rate_idx ON instagram_comment_events (account_id, instagram_account_id, private_reply_at)
  WHERE private_reply_status IN ('sent','unknown');

ALTER TABLE instagram_comment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_comment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON instagram_comment_events FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY worker_write ON instagram_comment_events FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON instagram_comment_events TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE ON instagram_comment_events TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_comment_events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
