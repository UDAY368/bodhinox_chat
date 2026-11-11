-- Stage 5 (5A): simple assignment modes, agent visibility and agent capacity
-- (5E implements the behaviour in src/lib/inbox/routing.ts and inbox-scope.ts).
--
--   workspace_inbox_settings.auto_assign_mode  'rules' (default) is today's
--       routing; 'basic' spreads new conversations over online agents; 'off'
--       assigns nothing.
--   workspace_inbox_settings.agent_visibility  'all' (default) is today's
--       behaviour; 'assigned_or_team' limits agents to their own, their team's
--       and unassigned conversations (enforced in application queries; tenancy
--       stays in RLS).
--   account_memberships.max_open_conversations  NULL (default) is no limit; an
--       agent at the limit is skipped by automatic assignment. Admins set it
--       through the existing admin update policy and a column grant.
--
-- Additive: constant defaults that reproduce today's behaviour (no rewrite),
-- checks NOT VALID here and validated by 20261118001200_stage5_validate.
SET LOCAL lock_timeout = '5s';

ALTER TABLE workspace_inbox_settings ADD COLUMN auto_assign_mode text NOT NULL DEFAULT 'rules';
ALTER TABLE workspace_inbox_settings ADD COLUMN agent_visibility text NOT NULL DEFAULT 'all';
ALTER TABLE workspace_inbox_settings ADD CONSTRAINT workspace_inbox_settings_auto_assign_mode_check
  CHECK (auto_assign_mode IN ('off','basic','rules')) NOT VALID;
ALTER TABLE workspace_inbox_settings ADD CONSTRAINT workspace_inbox_settings_agent_visibility_check
  CHECK (agent_visibility IN ('all','assigned_or_team')) NOT VALID;

ALTER TABLE account_memberships ADD COLUMN max_open_conversations integer;
ALTER TABLE account_memberships ADD CONSTRAINT account_memberships_max_open_conversations_check
  CHECK (max_open_conversations IS NULL OR max_open_conversations BETWEEN 1 AND 1000) NOT VALID;
GRANT UPDATE (max_open_conversations) ON account_memberships TO bodhinox_app;
