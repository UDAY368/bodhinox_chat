-- Phase 4b: forms that check answers on our data endpoint send one screen at a
-- time, so the answers collected so far are kept on the form session until the
-- last screen completes it. Additive; the worker already has UPDATE.
ALTER TABLE whatsapp_form_sessions ADD COLUMN answers jsonb NOT NULL DEFAULT '{}'::jsonb
  CONSTRAINT whatsapp_form_sessions_answers_check
  CHECK (jsonb_typeof(answers) = 'object' AND pg_column_size(answers) <= 65536);
