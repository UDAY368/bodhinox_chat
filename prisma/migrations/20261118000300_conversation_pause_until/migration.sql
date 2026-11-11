-- Stage 5 (5A): automations that resume by themselves (5D implements the
-- behaviour in src/lib/inbox/automation-pause.ts and bot-pause.ts).
--
--   conversations.bot_paused_until  NULL with bot_paused: paused until someone
--                                   resumes (today's behaviour). A time: the
--                                   pause ends then; an expired pause reads as
--                                   not paused.
--   conversations.bot_paused_by     who paused (audit identity, no foreign key).
--   workspace_inbox_settings.agent_reply_pause_minutes
--                                   how long an agent's reply pauses automations;
--                                   NULL keeps today's until-resumed behaviour.
--
-- Additive: nullable columns, no default, no rewrite. The minutes check is NOT
-- VALID here and validated by 20261118001200_stage5_validate (every existing
-- row is NULL, which passes).
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN bot_paused_until timestamptz;
ALTER TABLE conversations ADD COLUMN bot_paused_by uuid;
ALTER TABLE workspace_inbox_settings ADD COLUMN agent_reply_pause_minutes integer;
ALTER TABLE workspace_inbox_settings ADD CONSTRAINT workspace_inbox_settings_agent_reply_pause_check
  CHECK (agent_reply_pause_minutes IS NULL OR agent_reply_pause_minutes BETWEEN 1 AND 10080) NOT VALID;
