-- Phase 13: advisory intent and lead assessment per conversation. Written by
-- the worker only; agents and above read the current row (viewers do not:
-- a lead score is sales-sensitive). One current row per conversation; the
-- worker supersedes the old row and inserts the new one in one transaction,
-- serialised by the partial unique index. Writes nothing anywhere else.
-- Additive: a new, empty table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('pricing','purchase','booking','support','order_status','complaint',
    'sensitive_health','other','unknown')),
  intent_confidence smallint NOT NULL CHECK (intent_confidence BETWEEN 0 AND 100),
  lead_score smallint CHECK (lead_score BETWEEN 0 AND 100),
  qualification jsonb NOT NULL CHECK (jsonb_typeof(qualification) = 'object' AND pg_column_size(qualification) <= 4096),
  rationale text NOT NULL CHECK (char_length(rationale) <= 400),
  source_message_ids uuid[] NOT NULL CHECK (cardinality(source_message_ids) <= 40),
  source text NOT NULL CHECK (source IN ('model','deterministic')),
  model text CHECK (char_length(model) <= 200),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations(account_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ai_assessments_current_key ON ai_assessments (account_id, conversation_id)
  WHERE superseded_at IS NULL;
CREATE INDEX ai_assessments_contact_idx ON ai_assessments (account_id, contact_id)
  WHERE superseded_at IS NULL;
-- The cross-workspace retention due check (crm_accounts_with_ai_retention_due) probes by age.
CREATE INDEX ai_assessments_created_idx ON ai_assessments (created_at);
CREATE INDEX ai_assessments_superseded_idx ON ai_assessments (superseded_at)
  WHERE superseded_at IS NOT NULL;

ALTER TABLE ai_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON ai_assessments FOR SELECT TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_all ON ai_assessments FOR ALL TO bodhinox_worker
  USING (account_id = app_account_id()) WITH CHECK (account_id = app_account_id());
GRANT SELECT ON ai_assessments TO bodhinox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_assessments TO bodhinox_worker;
