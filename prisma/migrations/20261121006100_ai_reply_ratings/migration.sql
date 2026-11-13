-- Team ratings of AI replies (the AI Quality tab): a member marks a suggested
-- reply (ai_suggestions, kind 'reply') or an agent's sent reply
-- (ai_reply_events, outcome 'replied') as helpful or not helpful. One rating
-- per member per reply; changing it replaces it, clearing it deletes it. The
-- rating holds no customer content and goes with its reply (cascade), so the
-- AI retention sweep removes it with the reply.
--
-- user_id is audit identity (no foreign key, like ai_suggestions.created_by).
-- Members (agent and above) read every rating of the workspace and write only
-- their own (RLS); the worker only reads.
--
-- Additive: a new table with forced row-level security.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_reply_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  suggestion_id uuid,
  reply_event_id uuid,
  user_id uuid NOT NULL,
  vote text NOT NULL CHECK (vote IN ('up','down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((suggestion_id IS NULL) <> (reply_event_id IS NULL)),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, suggestion_id) REFERENCES ai_suggestions (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, reply_event_id) REFERENCES ai_reply_events (account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_reply_ratings_suggestion_key ON ai_reply_ratings (account_id, suggestion_id, user_id)
  WHERE suggestion_id IS NOT NULL;
CREATE UNIQUE INDEX ai_reply_ratings_event_key ON ai_reply_ratings (account_id, reply_event_id, user_id)
  WHERE reply_event_id IS NOT NULL;
CREATE INDEX ai_reply_ratings_account_idx ON ai_reply_ratings (account_id, created_at DESC);

ALTER TABLE ai_reply_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reply_ratings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_reply_ratings FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_read ON ai_reply_ratings FOR SELECT TO bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY own_write ON ai_reply_ratings FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent') AND user_id = app_user_id())
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_reply_ratings TO bodhinox_app;
GRANT SELECT ON ai_reply_ratings TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_reply_ratings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
