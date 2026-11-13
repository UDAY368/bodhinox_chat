-- Several AI agents per workspace. Each agent has a name, a role, its own
-- instructions, tone and handoff rules, the channels it answers on and its
-- working hours (always, only during, or only outside from..to in the
-- workspace's inbox time zone). The worker picks exactly one agent for a
-- customer message: the agent that already answered the conversation if it
-- is still eligible, otherwise the first enabled agent (by position, then age)
-- whose channel and hours match (src/lib/ai/agents.ts).
--
-- The existing single agent profile (ai_agent_profiles) stays the workspace's
-- business profile and becomes the default agent: the row with is_default
-- reads its instructions, tone and handoff rules from that profile, so the
-- setup wizard keeps working unchanged. A workspace with no ai_agents rows
-- keeps the old behaviour (one agent on every channel, at every hour); the
-- default row is created the first time an admin opens the agent list.
--
-- ai_reply_events gains agent_id in 20261123008000_ai_reply_event_agents
-- (that table is created by a later migration).
--
-- Additive: a new table with forced row-level security (every member reads,
-- admins write, the worker reads).
SET LOCAL lock_timeout = '5s';

CREATE TABLE ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL DEFAULT NULLIF(current_setting('app.account_id', true),'')::uuid
    REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  role text NOT NULL DEFAULT 'general' CHECK (role IN ('sales','support','bookings','orders','general')),
  instructions text CHECK (char_length(instructions) <= 4000),
  tone text CHECK (tone IS NULL OR tone IN ('friendly','professional','concise','enthusiastic','formal')),
  channels text[] NOT NULL DEFAULT ARRAY['whatsapp','instagram']::text[]
    CHECK (cardinality(channels) BETWEEN 1 AND 2 AND channels <@ ARRAY['whatsapp','instagram']::text[]),
  hours_mode text NOT NULL DEFAULT 'always' CHECK (hours_mode IN ('always','during','outside')),
  hours_from time,
  hours_to time,
  -- Same shape as ai_agent_profiles.handoff_rules; validated in src/lib/ai/agent-profile.ts.
  handoff_rules jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(handoff_rules) = 'object' AND pg_column_size(handoff_rules) <= 8192),
  enabled boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (hours_mode = 'always' OR (hours_from IS NOT NULL AND hours_to IS NOT NULL AND hours_from < hours_to)),
  UNIQUE (account_id, id)
);
CREATE UNIQUE INDEX ai_agents_default_key ON ai_agents (account_id) WHERE is_default;
CREATE UNIQUE INDEX ai_agents_name_key ON ai_agents (account_id, lower(name));
CREATE INDEX ai_agents_order_idx ON ai_agents (account_id, position, created_at);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON ai_agents FOR SELECT TO bodhinox_app, bodhinox_worker
  USING (account_id = app_account_id());
CREATE POLICY tenant_write ON ai_agents FOR ALL TO bodhinox_app
  USING (account_id = app_account_id() AND app_write_allowed('admin'))
  WITH CHECK (account_id = app_account_id() AND app_write_allowed('admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agents TO bodhinox_app;
GRANT SELECT ON ai_agents TO bodhinox_worker;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
