-- AI activity log: one row per customer message the WhatsApp auto-reply agent
-- handled after its first eligibility check (replied, handed off, skipped or
-- failed), so admins can see what it did and why. Written by the worker role
-- only (src/lib/ai/reply-events.ts); admins read it through GET /api/ai/activity.
-- Customer text and the reply are stored capped (2000 / 4096 characters) and
-- never logged; sources are at most 5 {document_id, title}, never chunk text.
-- Rows go with their conversation (and so with an erased contact) and are
-- deleted after 90 days by the AI retention sweep (src/lib/ai/retention.ts),
-- which this migration adds to crm_accounts_with_ai_retention_due().
--
-- Additive: a new, empty table, so plain indexes are fine. The foreign key
-- takes a brief lock on conversations (the only existing hot table here),
-- bounded by the lock timeout.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_reply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid,
  contact_id uuid,
  inbound_message_id text CHECK (char_length(inbound_message_id) <= 256),
  outcome text NOT NULL CHECK (outcome IN ('replied','handed_off','skipped','error')),
  reason text NOT NULL CHECK (char_length(reason) <= 64 AND reason ~ '^[a-z0-9_]+$'),
  customer_text text CHECK (char_length(customer_text) <= 2000),
  reply_text text CHECK (char_length(reply_text) <= 4096),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (CASE WHEN jsonb_typeof(sources) = 'array' THEN jsonb_array_length(sources) <= 5 AND pg_column_size(sources) <= 4096 ELSE false END),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  guard_flags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(guard_flags) <= 16),
  provider text CHECK (char_length(provider) <= 32),
  model text CHECK (char_length(model) <= 200),
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  latency_ms integer CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
-- The admin list: newest first with a (created_at, id) keyset, optionally by outcome.
CREATE INDEX ai_reply_events_list_idx ON ai_reply_events (account_id, created_at DESC, id DESC);
CREATE INDEX ai_reply_events_outcome_idx ON ai_reply_events (account_id, outcome, created_at DESC);
-- Supports the conversations foreign key (ON DELETE CASCADE) without scanning.
CREATE INDEX ai_reply_events_conversation_idx ON ai_reply_events (account_id, conversation_id);
-- The cross-workspace retention due check (crm_accounts_with_ai_retention_due) probes by age.
CREATE INDEX ai_reply_events_created_idx ON ai_reply_events (created_at);

ALTER TABLE ai_reply_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reply_events FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON ai_reply_events FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'));
CREATE POLICY worker_all ON ai_reply_events FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
-- The retention due definer runs as the migration owner, which FORCE RLS also binds
-- (same owner-only SELECT policy as the other AI tables in 20261111100700_ai_retention).
CREATE POLICY ai_retention_owner ON ai_reply_events FOR SELECT TO CURRENT_USER USING (true);
GRANT SELECT ON ai_reply_events TO bodhinox_app;
GRANT SELECT, INSERT, DELETE ON ai_reply_events TO bodhinox_worker;

-- Same definition as 20261111100700_ai_retention plus the ai_reply_events branch (90 days).
CREATE OR REPLACE FUNCTION crm_accounts_with_ai_retention_due() RETURNS TABLE(account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT due.account_id FROM (
    SELECT s.account_id FROM ai_suggestions s
      WHERE s.created_at < now() - interval '30 days'
        AND (s.created_at < now() - interval '180 days' OR s.output <> '{}'::jsonb OR s.citations <> '[]'::jsonb)
    UNION ALL
    SELECT a.account_id FROM ai_assessments a WHERE a.created_at < now() - interval '180 days'
    UNION ALL
    SELECT a.account_id FROM ai_assessments a
      WHERE a.superseded_at IS NOT NULL AND a.superseded_at < now() - interval '30 days'
    UNION ALL
    SELECT r.account_id FROM ai_insight_runs r WHERE r.created_at < now() - interval '90 days'
    UNION ALL
    SELECT u.account_id FROM ai_usage_log u WHERE u.created_at < now() - interval '400 days'
    UNION ALL
    SELECT e.account_id FROM ai_reply_events e WHERE e.created_at < now() - interval '90 days'
  ) due
  LIMIT 1000
$$;
REVOKE ALL ON FUNCTION crm_accounts_with_ai_retention_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_accounts_with_ai_retention_due() TO bodhinox_worker;
