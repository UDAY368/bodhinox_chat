-- Three more assistant features and the budget pause switch (the AI page's
-- Assistant features tab), plus question-and-answer knowledge sources.
--
-- ai_workspace_settings:
--   labelling_enabled       auto-labelling of new conversations (one model call per conversation)
--   translation_enabled     translate customer messages for staff, and staff drafts back
--   translation_language    the team language (a fixed list of language codes)
--   route_to_staff_enabled  hand sensitive (health) questions to a person in every conversation
--   pause_at_cap            when false, the workspace's own monthly_token_cap no longer
--                           stops the assistant features (the plan limit always applies)
-- All default off, except pause_at_cap (true keeps today's behaviour for a set cap).
--
-- ai_knowledge_sources.qa marks a 'text' source written as one question and
-- its answer (title = the question); it is indexed like any text source.
--
-- ai_usage_log.mode gains 'label' and 'translate'. The CHECK is re-added NOT
-- VALID (no scan under the lock); 20261114006200 validates it. Old values stay allowed.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_workspace_settings ADD COLUMN labelling_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE ai_workspace_settings ADD COLUMN translation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE ai_workspace_settings ADD COLUMN translation_language text NOT NULL DEFAULT 'en'
  CONSTRAINT ai_workspace_settings_translation_language_check
  CHECK (translation_language IN ('en','hi','te','ta','mr','kn','ml','bn','gu','pa','es','pt','ko','fr','de','ar'));
ALTER TABLE ai_workspace_settings ADD COLUMN route_to_staff_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE ai_workspace_settings ADD COLUMN pause_at_cap boolean NOT NULL DEFAULT true;

ALTER TABLE ai_knowledge_sources ADD COLUMN qa boolean NOT NULL DEFAULT false;

ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_mode_check; -- additive-exception: widened to allow label and translate; re-added below
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply','draft','summary','suggest','assess','insights','label','translate')) NOT VALID;
