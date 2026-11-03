-- Phase 7: AI agents foundation. Knowledge sources (websites, sitemaps, files,
-- typed text and answers learned from the inbox), the per-workspace agent
-- profile, the unanswered-questions queue and the flow builder's AI reply node.
--
-- All additive. New columns on ai_knowledge_documents are nullable (no table
-- rewrite). Crawled text, prompts and model output are customer content: they
-- live only in these tables and never in logs.

-- ================================================================ knowledge sources
CREATE TABLE ai_knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('website','sitemap','file','text','learning')),
  url text CHECK (url IS NULL OR char_length(url) BETWEEN 1 AND 2048),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','crawling','ready','failed','disabled')),
  page_limit integer NOT NULL DEFAULT 50 CHECK (page_limit BETWEEN 1 AND 500),
  pages_indexed integer NOT NULL DEFAULT 0 CHECK (pages_indexed >= 0),
  last_crawled_at timestamptz,
  -- A short operator-facing reason (never fetched page text).
  error text CHECK (char_length(error) <= 1000),
  created_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('website','sitemap') OR url IS NOT NULL),
  UNIQUE (account_id, id)
);
CREATE INDEX ai_knowledge_sources_tenant_idx ON ai_knowledge_sources (account_id, created_at DESC);
-- One 'learning' source per workspace holds the answers promoted from the inbox.
CREATE UNIQUE INDEX ai_knowledge_sources_learning_key ON ai_knowledge_sources (account_id) WHERE kind = 'learning';
ALTER TABLE ai_knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_knowledge_sources FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON ai_knowledge_sources FOR ALL TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE,DELETE ON ai_knowledge_sources TO bodhinox_app,bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ documents gain a source
ALTER TABLE ai_knowledge_documents ADD COLUMN source_id uuid;
ALTER TABLE ai_knowledge_documents ADD COLUMN source_url text
  CONSTRAINT ai_knowledge_documents_source_url_check CHECK (source_url IS NULL OR char_length(source_url) BETWEEN 1 AND 2048);
ALTER TABLE ai_knowledge_documents ADD COLUMN content_hash text
  CONSTRAINT ai_knowledge_documents_content_hash_check CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE ai_knowledge_documents ADD COLUMN fetched_at timestamptz;
ALTER TABLE ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_source_id_fkey
  FOREIGN KEY (account_id, source_id) REFERENCES ai_knowledge_sources (account_id, id) ON DELETE CASCADE;
-- A re-crawl updates the page in place (NULL source_url rows never conflict).
ALTER TABLE ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_source_page_key
  UNIQUE (account_id, source_id, source_url);
CREATE INDEX ai_knowledge_documents_source_idx ON ai_knowledge_documents (account_id, source_id)
  WHERE source_id IS NOT NULL;

-- ================================================================ agent profile
CREATE TABLE ai_agent_profiles (
  account_id uuid PRIMARY KEY DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  business_name text CHECK (char_length(business_name) <= 200),
  business_type text CHECK (char_length(business_type) <= 100),
  website_url text CHECK (char_length(website_url) <= 2048),
  instructions text CHECK (char_length(instructions) <= 4000),
  greeting text CHECK (char_length(greeting) <= 1024),
  tone text CHECK (char_length(tone) <= 50),
  -- {keywords:[], on_low_confidence:bool, confidence_threshold:0..1,
  --  max_turns_before_handoff:int}; validated in src/lib/ai/agent-profile.ts.
  handoff_rules jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(handoff_rules) = 'object' AND pg_column_size(handoff_rules) <= 8192),
  setup_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_agent_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_agent_profiles FOR SELECT TO bodhinox_app,bodhinox_worker
  USING (account_id=app_account_id());
CREATE POLICY tenant_write ON ai_agent_profiles FOR ALL TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('admin'));
GRANT SELECT,INSERT,UPDATE ON ai_agent_profiles TO bodhinox_app;
GRANT SELECT ON ai_agent_profiles TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agent_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================================ unanswered questions
CREATE TABLE ai_unanswered_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid,
  contact_id uuid,
  question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 2000),
  normalized_question text NOT NULL CHECK (char_length(normalized_question) BETWEEN 1 AND 2000),
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  last_asked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  answer text CHECK (char_length(answer) <= 4000),
  answered_by uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  answered_at timestamptz,
  promoted_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'answered' OR (answer IS NOT NULL AND char_length(btrim(answer)) > 0 AND answered_at IS NOT NULL)),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, conversation_id) REFERENCES conversations (account_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (account_id, contact_id) REFERENCES contacts (account_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (account_id, promoted_document_id) REFERENCES ai_knowledge_documents (account_id, id)
    ON DELETE SET NULL (promoted_document_id)
);
-- The same open question is counted, not duplicated.
CREATE UNIQUE INDEX ai_unanswered_questions_open_key
  ON ai_unanswered_questions (account_id, normalized_question) WHERE status = 'open';
CREATE INDEX ai_unanswered_questions_list_idx
  ON ai_unanswered_questions (account_id, status, last_asked_at DESC);
ALTER TABLE ai_unanswered_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_unanswered_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_read ON ai_unanswered_questions FOR SELECT TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY agent_update ON ai_unanswered_questions FOR UPDATE TO bodhinox_app
  USING (account_id=app_account_id() AND app_write_allowed('agent'))
  WITH CHECK (account_id=app_account_id() AND app_write_allowed('agent'));
CREATE POLICY worker_all ON ai_unanswered_questions FOR ALL TO bodhinox_worker
  USING (account_id=app_account_id()) WITH CHECK (account_id=app_account_id());
GRANT SELECT ON ai_unanswered_questions TO bodhinox_app;
GRANT UPDATE (status, answer, answered_by, answered_at, promoted_document_id) ON ai_unanswered_questions TO bodhinox_app;
GRANT SELECT,INSERT,UPDATE ON ai_unanswered_questions TO bodhinox_worker;

-- ================================================================ flow builder: AI reply node
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_buttons','send_list','send_message','send_media','collect_input','condition','set_tag','handoff','http_fetch','end',
  'set_attribute','ask_media','ask_location','ask_address',
  'send_template','api_request','connect_flow','assign_agent',
  'send_form',
  'send_product','send_product_list','send_catalog','payment_link',
  'ai_reply'));

ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired','handoff','timeout','error','completed',
  'delay_scheduled','input_invalid','attribute_set',
  'api_request','flow_connected','agent_assigned',
  'form_sent','form_submitted',
  'payment_link_sent','payment_received','payment_expired','order_received',
  'ai_replied','ai_handoff'));
