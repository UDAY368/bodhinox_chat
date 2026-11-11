-- Stage 5 close: a draft-only change marker for autosave conflicts.
--
-- flows.updated_at moves on every row update (the generic set_updated_at
-- trigger), including the execution counter each live run bumps, number
-- changes and folder moves. Autosave compared the editor's base with it, so a
-- flow that ran while someone edited it refused the next autosave as if
-- another editor had saved. draft_saved_at is written only by a draft save
-- (saveDraft); the conflict check compares with it, falling back to
-- updated_at while it is NULL (flows not saved since this migration).
-- Additive: one nullable column, no backfill (a backfill UPDATE would move
-- every flow's updated_at through the trigger).
SET LOCAL lock_timeout = '5s';

ALTER TABLE flows ADD COLUMN draft_saved_at timestamptz;
