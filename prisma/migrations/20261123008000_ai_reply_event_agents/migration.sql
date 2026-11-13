-- Which AI agent (ai_agents, 20261123005000_ai_multi_agents) handled each
-- auto-reply event, so every agent's conversations handled and share solved
-- without a person come from recorded data. Null for rows written before
-- agents existed and for workspaces still on the single legacy agent.
--
-- Additive: one nullable column and a NOT VALID foreign key (new rows are
-- checked; existing rows are all null). Deleting an agent keeps its events.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_reply_events ADD COLUMN agent_id uuid;
ALTER TABLE ai_reply_events ADD CONSTRAINT ai_reply_events_agent_fkey
  FOREIGN KEY (account_id, agent_id) REFERENCES ai_agents (account_id, id) ON DELETE SET NULL (agent_id) NOT VALID;
