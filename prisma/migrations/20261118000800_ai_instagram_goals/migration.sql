-- Stage 5 (5A): goals for the workspace's Instagram AI auto-reply (5G
-- implements them in src/lib/ai/goals.ts and the AI settings page).
-- [] (default) is today's behaviour: no goals. At most 3 ordered goals, the
-- same shape as an ai_reply step's `goals` (src/lib/flows/types.ts AiGoal).
-- Additive: a constant default (no rewrite); the check is NOT VALID here and
-- validated by 20261118001200_stage5_validate.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_workspace_settings ADD COLUMN instagram_goals jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai_workspace_settings ADD CONSTRAINT ai_workspace_settings_instagram_goals_check
  CHECK (jsonb_typeof(instagram_goals) = 'array' AND jsonb_array_length(instagram_goals) <= 3
    AND octet_length(instagram_goals::text) <= 16384) NOT VALID;
