-- Phase 13: AI summaries and suggested replies shown to staff. Nothing here is
-- ever sent by the system: a member inserts a suggestion into the composer
-- and presses Send; the send route then records which message used it.
--
-- Agents may create suggestions as themselves and decide (accept, edit,
-- reject) a suggestion that is still 'shown', only as themselves. They can
-- never rewrite the model output (no UPDATE grant on output/citations).
-- created_by is audit identity (no foreign key, like report_schedules), so
-- removing a user never fails on old suggestions; retention deletes them.
-- Additive: a new, empty table, so plain indexes are fine.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('summary','reply','route_to_staff')),
  status text NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','accepted','edited','rejected')),
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object' AND pg_column_size(output) <= 16384),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array' AND pg_column_size(citations) <= 8192),
  guard_flags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(guard_flags) <= 16),
  provider text CHECK (char_length(provider) <= 32),
  model text CHECK (char_length(model) <= 200),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  sent_message_id uuid,
  edit_distance smallint CHECK (edit_distance BETWEEN 0 AND 1000),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, sent_message_id) REFERENCES messages(account_id, id) ON DELETE SET NULL (sent_message_id)
);
CREATE INDEX ai_suggestions_account_created_idx ON ai_suggestions (account_id, created_at DESC);
CREATE INDEX ai_suggestions_conversation_idx ON ai_suggestions (account_id, conversation_id, created_at DESC);
-- The cross-workspace retention due check (crm_accounts_with_ai_retention_due) probes by age.
CREATE INDEX ai_suggestions_created_idx ON ai_suggestions (created_at);
-- Supports the messages foreign key (ON DELETE SET NULL) without scanning.
CREATE INDEX ai_suggestions_sent_message_idx ON ai_suggestions (account_id, sent_message_id)
  WHERE sent_message_id IS NOT NULL;

ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON ai_suggestions FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent'));
CREATE POLICY agent_insert ON ai_suggestions FOR INSERT TO bodhinox_app
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND created_by = app_user_id()
    AND status = 'shown' AND decided_by IS NULL AND sent_message_id IS NULL);
CREATE POLICY agent_decide ON ai_suggestions FOR UPDATE TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent') AND status = 'shown')
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('agent') AND decided_by = app_user_id());
CREATE POLICY worker_all ON ai_suggestions FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON ai_suggestions TO bodhinox_app;
GRANT INSERT (account_id, conversation_id, kind, output, citations, guard_flags, provider, model, prompt_version, created_by)
  ON ai_suggestions TO bodhinox_app;
GRANT UPDATE (status, decided_by, decided_at, sent_message_id, edit_distance) ON ai_suggestions TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_suggestions TO bodhinox_worker;
